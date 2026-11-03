import { describe, expect, it } from "vitest";

import {
  DIGITAL_ZERO_RMS,
  MIC_SILENCE_THRESHOLD_MS,
  createMicSilenceTracker,
} from "../src/domain/logic/mic-silence";

describe("MicSilenceTracker", () => {
  it("stays quiet below the threshold and fires only after the full window", () => {
    const tracker = createMicSilenceTracker();

    // 89.9 s of digital zero — one poll short of the verdict.
    for (let elapsed = 0; elapsed <= 89_900; elapsed += 100) {
      expect(tracker.feed(0, elapsed)).toBe(false);
    }
    expect(tracker.feed(0, MIC_SILENCE_THRESHOLD_MS)).toBe(true);
    expect(tracker.isSilent()).toBe(true);
  });

  it("a single live frame resets the whole streak", () => {
    const tracker = createMicSilenceTracker();
    for (let elapsed = 0; elapsed <= 90_000; elapsed += 100) {
      tracker.feed(0, elapsed);
    }
    expect(tracker.isSilent()).toBe(true);

    expect(tracker.feed(0.002, 90_100)).toBe(false);
    expect(tracker.isSilent()).toBe(false);

    // The streak restarts from zero, not from the old silentSince.
    expect(tracker.feed(0, 90_200)).toBe(false);
    expect(tracker.feed(0, 90_200 + MIC_SILENCE_THRESHOLD_MS - 100)).toBe(false);
    expect(tracker.feed(0, 90_200 + MIC_SILENCE_THRESHOLD_MS)).toBe(true);
  });

  it("a noise-floor-level signal counts as life (the whole point of the raw detector)", () => {
    const tracker = createMicSilenceTracker();
    let verdict = false;
    for (let elapsed = 0; elapsed <= MIC_SILENCE_THRESHOLD_MS * 2; elapsed += 100) {
      verdict = tracker.feed(DIGITAL_ZERO_RMS * 10, elapsed);
    }
    expect(verdict).toBe(false);
  });

  it("the epsilon boundary itself is silence, NaN is silence (never proves life)", () => {
    const tracker = createMicSilenceTracker();
    for (let elapsed = 0; elapsed <= MIC_SILENCE_THRESHOLD_MS; elapsed += 100) {
      tracker.feed(DIGITAL_ZERO_RMS, elapsed);
      tracker.feed(Number.NaN, elapsed + 50);
    }
    expect(tracker.isSilent()).toBe(true);
  });

  it("reset drops the verdict and the streak", () => {
    const tracker = createMicSilenceTracker();
    tracker.feed(0, 0);
    tracker.feed(0, MIC_SILENCE_THRESHOLD_MS);
    expect(tracker.isSilent()).toBe(true);

    tracker.reset();
    expect(tracker.isSilent()).toBe(false);
    // Fresh streak: the pre-reset zero seconds must not count.
    expect(tracker.feed(0, MIC_SILENCE_THRESHOLD_MS + 10_000)).toBe(false);
  });
});
