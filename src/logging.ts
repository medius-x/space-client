/**
 * Leveled logger → console + a bounded ring buffer the diagnostics panel renders.
 * Every protocol module funnels through here so the spike's evidence trail is one place.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
}

const RING_CAPACITY = 400;

const ring: LogEntry[] = [];
const ringListeners = new Set<() => void>();

declare global {
  interface Window {
    spaceLog?: { write(line: string): void };
  }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
}

function record(level: LogLevel, tag: string, message: string): void {
  const entry = { timestamp: timestamp(), level, tag, message };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) {
    ring.shift();
  }
  const line = `[${entry.timestamp}] [${tag}] ${message}`;
  const consoleMethod = level === "debug" ? "log" : level;
  // eslint-disable-next-line no-console -- the spike's console IS a deliverable surface
  console[consoleMethod](line);
  // Persist through the preload bridge into the per-instance space.log (main appends).
  // Guarded: unit tests import this module in node, where window does not exist.
  if (typeof window !== "undefined") {
    window.spaceLog?.write(line);
  }
  for (const listener of ringListeners) {
    listener();
  }
}

export const log = {
  debug: (tag: string, message: string) => record("debug", tag, message),
  info: (tag: string, message: string) => record("info", tag, message),
  warn: (tag: string, message: string) => record("warn", tag, message),
  error: (tag: string, message: string) => record("error", tag, message),
  entries: (): readonly LogEntry[] => ring,
  subscribe: (listener: () => void): (() => void) => {
    ringListeners.add(listener);
    return () => {
      ringListeners.delete(listener);
    };
  },
};
