import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reservedVideoThumbBox } from "../src/domain/logic/attachment-layout";
import { learnedDims, rememberDims } from "../src/renderer/media-dims";

/** An in-memory localStorage stand-in (the node test env has none). */
function stubLocalStorage(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  return { store };
}

describe("reservedVideoThumbBox (the exact aspect reservation)", () => {
  it("a landscape video fits the width cap first", () => {
    // 1920×1080 into (480 wide, 320 high): the width is the binding side.
    expect(reservedVideoThumbBox(1920, 1080, 480, 320)).toEqual({ width: 480, height: 270 });
  });

  it("a vertical phone video reserves the tall narrow box", () => {
    expect(reservedVideoThumbBox(720, 1280, 480, 320)).toEqual({ width: 180, height: 320 });
  });

  it("a small video never upscales", () => {
    expect(reservedVideoThumbBox(320, 180, 480, 320)).toEqual({ width: 320, height: 180 });
  });

  it("unknown dimensions fall back to the historical 16:9 plate", () => {
    expect(reservedVideoThumbBox(0, 0, 480, 320)).toEqual({ width: 320, height: 180 });
    expect(reservedVideoThumbBox(0, 0, 200, 320)).toEqual({ width: 200, height: 113 });
  });
});

describe("media-dims (the legacy learned cache)", () => {
  beforeEach(() => {
    stubLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers and recalls dimensions by key; invalid entries are ignored", () => {
    expect(learnedDims("att/legacy")).toBeNull();
    rememberDims("att/legacy", 2200, 1600);
    expect(learnedDims("att/legacy")).toEqual({ width: 2200, height: 1600 });
    rememberDims("att/broken", 0, 100); // degenerate — not stored
    expect(learnedDims("att/broken")).toBeNull();
    expect(learnedDims(null)).toBeNull();
  });

  it("persists through a fresh module load (localStorage round-trip, debounced)", async () => {
    vi.useFakeTimers();
    // Fresh module state: the previous test left a REAL debounce timer armed,
    // which fake timers would never fire.
    vi.resetModules();
    const fresh = await import("../src/renderer/media-dims");
    fresh.rememberDims("att/persist", 640, 480);
    // The write is debounced (500ms) — one localStorage write per decode burst,
    // not a full-map stringify per onLoad.
    vi.advanceTimersByTime(600);
    vi.resetModules();
    const reloaded = await import("../src/renderer/media-dims");
    expect(reloaded.learnedDims("att/persist")).toEqual({ width: 640, height: 480 });
    vi.useRealTimers();
  });
});
