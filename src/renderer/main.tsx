import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PopoutScreen } from "./components/PopoutScreen";
import { ToastStackScreen } from "./components/ToastStackScreen";
import { bootstrapApp } from "./runtime";
import { log } from "../logging";
import "./styles/global.css";
import "./styles/icons.css";

// Jank tracer (diagnostics): long tasks and slow input/scroll events land in
// space.log with their durations — a "sticky scroll" report turns into numbers
// instead of guesses. The event observer names the interaction ("scroll",
// "wheel", "keydown"…); longtask covers render/layout bursts with no event name.
try {
  // durationThreshold is Event Timing (Chromium) — the TS DOM lib lags behind it.
  const eventObserverInit: PerformanceObserverInit & { durationThreshold?: number } = {
    type: "event",
    durationThreshold: 100,
  };
  new PerformanceObserver((entryList) => {
    for (const entry of entryList.getEntries()) {
      log.warn("perf", `${entry.name} ${Math.round(entry.duration)}ms`);
    }
  }).observe(eventObserverInit);
  new PerformanceObserver((entryList) => {
    for (const entry of entryList.getEntries()) {
      log.warn("perf", `longtask ${Math.round(entry.duration)}ms`);
    }
  }).observe({ entryTypes: ["longtask"] });
} catch {
  // observers unavailable — diagnostics only, never fatal
}

// Frame-stall tracer (diagnostics): longtask only sees MAIN-thread blocks —
// freezes that drop frames on the compositor/raster threads (image decode,
// texture upload while scrolling) stay invisible there. A rAF loop sees every
// frame the page actually presented: 2+ consecutive slow frames open a stall,
// the first fast frame closes it and logs the totals.
try {
  const SLOW_FRAME_MS = 34; // below ~30 fps
  let lastFrame = performance.now();
  let stallFrames = 0;
  let stallTotal = 0;
  let stallLongest = 0;
  const frameTick = (now: number): void => {
    const gap = now - lastFrame;
    lastFrame = now;
    if (gap >= 1000) {
      // the page was hidden (rAF throttled) — not a stall, never mind
    } else if (gap >= SLOW_FRAME_MS) {
      stallFrames += 1;
      stallTotal += gap;
      stallLongest = Math.max(stallLongest, gap);
    } else if (stallFrames >= 2) {
      log.warn("perf", `frame-stall ${Math.round(stallTotal)}ms over ${stallFrames} frames (longest ${Math.round(stallLongest)}ms)`);
      stallFrames = 0;
      stallTotal = 0;
      stallLongest = 0;
    } else {
      stallFrames = 0;
      stallTotal = 0;
      stallLongest = 0;
    }
    requestAnimationFrame(frameTick);
  };
  requestAnimationFrame(frameTick);
} catch {
  // diagnostics only, never fatal
}

const container = document.querySelector<HTMLElement>("#root");
if (!container) {
  throw new Error("#root not found");
}

if (window.location.hash === "#toasts") {
  // The always-on-top toast overlay window: a card stack only — no sessions,
  // no bootstrap (oak's NotificationToast). Deliberately NOT under StrictMode
  // (like the pop-out): its double-mounted effects would double-subscribe the
  // IPC card sink and every toast would arrive twice (live report).
  createRoot(container).render(<ToastStackScreen />);
} else if (window.location.hash === "#popout") {
  // The share pop-out window: a frame viewer only — no sessions, no bootstrap.
  createRoot(container).render(<PopoutScreen />);
} else {
  // Auto-resume the most recent connection (or land on the login screen).
  void bootstrapApp();

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
