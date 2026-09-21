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

let isWindowFn: ((hwnd: unknown) => number) | null = null;
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
  if (isWindowFn === null) {
    const user32 = koffi.load("user32.dll");
    isWindowFn = user32.func("int IsWindow(void *hwnd)") as unknown as (hwnd: unknown) => number;
  }
  const handle = koffi.as(BigInt(hwnd), "void *");
  watchTimer = setInterval(() => {
    if (isWindowFn!(handle) === 0) {
      if (watchTimer !== null) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
      onDead(sourceId);
    }
  }, 500);
  return true;
}
