import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PopoutScreen } from "./components/PopoutScreen";
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

const container = document.querySelector<HTMLElement>("#root");
if (!container) {
  throw new Error("#root not found");
}

if (window.location.hash === "#popout") {
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
