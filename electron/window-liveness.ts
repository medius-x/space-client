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
 *  probe, GetClientRect for the picker's resolution cutoff). */
interface User32Fns {
  isWindow: (hwnd: unknown) => number;
  getClientRect: (hwnd: unknown, rect: unknown) => number;
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
    };
  }
  return user32Fns;
}

function hwndHandle(hwnd: number): unknown {
  return koffi!.as(BigInt(hwnd), "void *");
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

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
