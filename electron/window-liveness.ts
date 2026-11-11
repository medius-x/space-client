/**
 * Window-share liveness watchdog (the oak SfuService precedent: "IsWindow
 * every 2 s → the ordinary stop path"). Chromium's window capture does NOT
 * fire the track's "ended" when the captured window closes — WGC freezes the
 * last frame, the publisher keeps sending it, and every viewer's UI keeps
 * showing a live share long after the window died. Polling user32 IsWindow
 * from the main process closes that gap; the dead HWND routes the share into
 * its ORDINARY stop path on the renderer side.
 *
 * Poll cadence 500 ms (oak polls at 2 s; one IsWindow call is nanoseconds —
 * the snappier teardown is worth it). ONE watch at a time; arming a new one
 * replaces the old.
 *
 * The same lazy user32 binding also feeds the share-quality picker: the
 * client-area size (GetClientRect) caps the offered resolutions, and a cheap
 * IsWindow probe decides whether the picker's source cache may serve a grant.
 */

// Native module, loaded defensively (the system-audio.ts pattern): without
// koffi the watchdog reports unavailable and the ended-track/manual-stop
// paths remain the only safety net.
declare const require: (id: string) => unknown;

type KoffiModule = {
  load: (library: string) => { func: (signature: string) => (...args: never[]) => unknown };
  as: (value: unknown, type: string) => unknown;
  proto: (signature: string) => unknown;
  pointer: (type: unknown) => unknown;
  register: (callback: (hwnd: unknown, lParam: unknown) => number, pointerType: unknown) => unknown;
  unregister: (callback: unknown) => void;
};

let koffi: KoffiModule | null = null;
try {
  koffi = require("koffi") as KoffiModule;
} catch {
  koffi = null;
}

/** The HWND segment of a desktopCapturer window source id ("window:HWND:…",
 *  decimal) — null for malformed ids. */
export function parseWindowHwnd(sourceId: string): number | null {
  const hwnd = Number.parseInt(sourceId.split(":")[1] ?? "", 10);
  return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
}

export function isWindowLivenessAvailable(): boolean {
  return koffi !== null && process.platform === "win32";
}

/** The shared user32 binding (IsWindow for the watchdog + the grant-cache
 *  probe, GetClientRect for the picker's resolution cutoff, GetWindowThread
 * ProcessId for the activity picker's app/background split). */
interface User32Fns {
  isWindow: (hwnd: unknown) => number;
  getClientRect: (hwnd: unknown, rect: unknown) => number;
  getWindowThreadProcessId: (hwnd: unknown, pidOut: unknown) => number;
  isWindowVisible: (hwnd: unknown) => number;
  isIconic: (hwnd: unknown) => number;
  getWindowTextW: (hwnd: unknown, text: unknown, maxCount: number) => number;
  enumWindows: (callback: unknown, lParam: number) => number;
}

let user32Fns: User32Fns | null = null;

function ensureUser32(): User32Fns | null {
  if (user32Fns === null && koffi !== null) {
    const user32 = koffi.load("user32.dll");
    user32Fns = {
      isWindow: user32.func("int IsWindow(void *hwnd)") as unknown as (hwnd: unknown) => number,
      // _Out_ rect — koffi copies the 16-byte RECT (4 × int32 LE) into the
      // Node Buffer argument after the call (the memcpyOut idiom).
      getClientRect: user32.func("int GetClientRect(void *hwnd, _Out_ void *rect)") as unknown as (hwnd: unknown, rect: unknown) => number,
      getWindowThreadProcessId: user32.func("uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)") as unknown as (hwnd: unknown, pidOut: unknown) => number,
      isWindowVisible: user32.func("int IsWindowVisible(void *hwnd)") as unknown as (hwnd: unknown) => number,
      isIconic: user32.func("int IsIconic(void *hwnd)") as unknown as (hwnd: unknown) => number,
      getWindowTextW: user32.func("int GetWindowTextW(void *hwnd, _Out_ wchar_t *text, int maxCount)") as unknown as (hwnd: unknown, text: unknown, maxCount: number) => number,
      enumWindows: user32.func("int EnumWindows(void *callback, intptr_t lParam)") as unknown as (callback: unknown, lParam: number) => number,
    };
  }
  return user32Fns;
}

/** The EnumWindows callback POINTER type — a LAZY SINGLETON, the named-type
 *  registration lesson of process-snapshot (a second registration throws).
 *  koffi.register wants the POINTER flavor: koffi.pointer(proto(fn)) — the
 *  bare function prototype throws "expected <callback> *" (probed live,
 *  2026-11-11). */
let enumCbPointer: unknown = null;

function ensureEnumCbPointer(): unknown {
  if (enumCbPointer === null && koffi !== null) {
    enumCbPointer = koffi.pointer(koffi.proto("int32_t OAK_EnumWindowsCb(void *hwnd, intptr_t lParam)"));
  }
  return enumCbPointer;
}

/** DWMWA_CLOAKED: a UWP app's "window" lingers INVISIBLE-but-present after the
 *  real window closes (the Photos.exe trap); those must not read as apps. */
const DWMWA_CLOAKED = 14;

interface DwmFns {
  getDwmWindowAttribute: (hwnd: unknown, attribute: number, value: unknown, size: number) => number;
}

let dwmFns: DwmFns | null | undefined; // undefined = not attempted yet

function ensureDwmApi(): DwmFns | null {
  if (dwmFns === undefined) {
    dwmFns = null;
    try {
      if (koffi !== null) {
        const dwm = koffi.load("dwmapi.dll");
        dwmFns = {
          getDwmWindowAttribute: dwm.func("int32_t DwmGetWindowAttribute(void *hwnd, uint32_t attr, void *value, uint32_t size)") as unknown as (hwnd: unknown, attribute: number, value: unknown, size: number) => number,
        };
      }
    } catch {
      dwmFns = null; // pre-DWM Windows — every window reads as uncloaked
    }
  }
  return dwmFns;
}

function hwndHandle(hwnd: number): unknown {
  return koffi!.as(BigInt(hwnd), "void *");
}

/** The owning process id of a window (null when unknown — the idiom of
 *  system-audio's windowPid): the activity picker classifies a process as an
 *  "application" when one of its windows is capturable. */
export function windowPidOf(hwnd: number): number | null {
  const user32 = ensureUser32();
  if (user32 === null) {
    return null;
  }
  const pidOut = Buffer.alloc(4);
  const threadId = user32.getWindowThreadProcessId(hwndHandle(hwnd), pidOut);
  if (threadId === 0) {
    return null; // not a window anymore
  }
  const pid = pidOut.readUInt32LE(0);
  return pid > 0 ? pid : null;
}

/**
 * VISIBLE top-level windows with titles: pid → title, the first window per
 * pid winning (the picker's idiom). MINIMIZED windows are included —
 * minimizing does not unset WS_VISIBLE, and desktopCapturer (the picker's old
 * window layer) drops them (the user report, 2026-11-11); cloaked UWP
 * remnants are excluded via DWMWA_CLOAKED. Null when unavailable (no koffi /
 * not win32) — the caller then reads everyone as a background process.
 */
export function visibleWindowTitlesByPid(): Map<number, string> | null {
  const user32 = ensureUser32();
  const callbackType = ensureEnumCbPointer();
  if (user32 === null || callbackType === null) {
    return null;
  }
  const dwm = ensureDwmApi();
  const out = new Map<number, string>();
  let registered: unknown = null;
  try {
    registered = koffi!.register((hwnd: unknown): number => {
      if (user32.isWindowVisible(hwnd) === 0) {
        return 1; // keep enumerating
      }
      if (dwm !== null) {
        const cloaked = Buffer.alloc(4);
        if (dwm.getDwmWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked.readUInt32LE(0) !== 0) {
          return 1; // a suspended UWP shell behind a closed window
        }
      }
      const text = Buffer.alloc(512); // wchar_t[256]
      const length = user32.getWindowTextW(hwnd, text, 256);
      if (length <= 0) {
        return 1;
      }
      const pidOut = Buffer.alloc(4);
      if (user32.getWindowThreadProcessId(hwnd, pidOut) === 0) {
        return 1;
      }
      const pid = pidOut.readUInt32LE(0);
      if (pid > 0 && !out.has(pid)) {
        out.set(pid, text.slice(0, length * 2).toString("utf16le"));
      }
      return 1; // keep enumerating
    }, callbackType);
    user32.enumWindows(registered, 0);
  } catch {
    return out.size > 0 ? out : null; // a partial walk still classifies what it saw
  } finally {
    if (registered !== null) {
      koffi!.unregister(registered);
    }
  }
  return out;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** The minimized-state watch's own single slot (2026-11-11): a MINIMIZED
 *  shared window does not die — WGC freezes its last frame and the viewers
 *  stare at a still picture with no idea why. The poll flips only on CHANGE:
 *  onIconic fires exactly once per minimize and once per restore. */
let iconicWatchTimer: ReturnType<typeof setInterval> | null = null;
let iconicWatchHwnd: number | null = null;
let iconicLast: boolean | null = null;

/** Arm the minimized watch for ONE window source (null cancels). Resolves
 *  false when unavailable (no koffi / malformed id) — the caller simply goes
 *  without the "window minimized" hint. */
export function watchSourceIconic(sourceId: string | null, onIconic: (iconic: boolean) => void): boolean {
  if (iconicWatchTimer !== null) {
    clearInterval(iconicWatchTimer);
    iconicWatchTimer = null;
  }
  if (sourceId === null) {
    iconicWatchHwnd = null;
    iconicLast = null;
    return false;
  }
  const hwnd = parseWindowHwnd(sourceId);
  if (hwnd === null || koffi === null || process.platform !== "win32") {
    return false;
  }
  const user32 = ensureUser32();
  if (user32 === null) {
    return false;
  }
  const handle = hwndHandle(hwnd);
  iconicWatchHwnd = hwnd;
  iconicLast = null;
  iconicWatchTimer = setInterval(() => {
    if (user32.isWindow(handle) === 0 || iconicWatchHwnd !== hwnd) {
      // The window died — the liveness watch owns that path; this watch ends.
      if (iconicWatchTimer !== null) {
        clearInterval(iconicWatchTimer);
        iconicWatchTimer = null;
      }
      iconicWatchHwnd = null;
      iconicLast = null;
      return;
    }
    const iconic = user32.isIconic(handle) !== 0;
    if (iconic !== iconicLast) {
      iconicLast = iconic;
      onIconic(iconic);
    }
  }, 500);
  return true;
}

/** Arm the liveness watch for ONE window source; `null` cancels any running
 *  watch. Resolves false when the watchdog is unavailable or the id is
 *  malformed (the caller just goes on without the safety net). */
export function watchSourceLiveness(sourceId: string | null, onDead: (sourceId: string) => void): boolean {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (sourceId === null || koffi === null || process.platform !== "win32") {
    return false;
  }
  const hwnd = parseWindowHwnd(sourceId);
  if (hwnd === null) {
    return false;
  }
  const user32 = ensureUser32();
  if (user32 === null) {
    return false;
  }
  const handle = hwndHandle(hwnd);
  watchTimer = setInterval(() => {
    if (user32.isWindow(handle) === 0) {
      if (watchTimer !== null) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
      onDead(sourceId);
    }
  }, 500);
  return true;
}

/** Confirmed-dead probe for the grant's picker cache: false only when user32
 *  positively reports the HWND gone (or the id is malformed). An UNVERIFIABLE
 *  window (no koffi / not win32) reads as alive — the cache stays usable and
 *  the capture itself fails honestly if the window really vanished. */
export function isWindowConfirmedDead(sourceId: string): boolean {
  const hwnd = parseWindowHwnd(sourceId);
  if (hwnd === null) {
    return true; // malformed id — nothing to serve from any cache
  }
  const user32 = koffi !== null && process.platform === "win32" ? ensureUser32() : null;
  if (user32 === null) {
    return false;
  }
  return user32.isWindow(hwndHandle(hwnd)) === 0;
}

export interface WindowClientSize {
  width: number;
  height: number;
}

/**
 * The window's CLIENT-area size in pixels (WGC captures the client area, not
 * the frame) — the picker's resolution cutoff for window shares. Null when
 * unavailable (not win32, no koffi, window gone): the picker then offers the
 * full ladder rather than a wrong cutoff.
 */
export function getClientSize(sourceId: string): WindowClientSize | null {
  const hwnd = parseWindowHwnd(sourceId);
  if (hwnd === null || koffi === null || process.platform !== "win32") {
    return null;
  }
  const user32 = ensureUser32();
  if (user32 === null) {
    return null;
  }
  const rect = Buffer.allocUnsafe(16); // RECT {left, top, right, bottom}, int32 LE
  if (user32.getClientRect(hwndHandle(hwnd), rect) === 0) {
    return null;
  }
  const left = rect.readInt32LE(0);
  const top = rect.readInt32LE(4);
  const right = rect.readInt32LE(8);
  const bottom = rect.readInt32LE(12);
  return { width: right - left, height: bottom - top };
}
