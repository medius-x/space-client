import { describe, expect, it } from "vitest";
import {
  applyRecenterShot,
  INITIAL_RECENTER_STATE,
  modulatedNoise,
  RECENTER_TRACK_WINDOW,
  recenterSearchRange,
  type RecenterState,
} from "../src/domain/logic/share-recenter";

const lockedAt = (delay: number): RecenterState => ({ delay, locked: true, pendingShift: 0, pendingCount: 0 });

describe("recenterSearchRange", () => {
  it("locks the search to a narrow window around the current delay (pitch aliases stay outside)", () => {
    const range = recenterSearchRange(lockedAt(9000), 16000);
    expect(range.minLag).toBe(9000 - RECENTER_TRACK_WINDOW);
    expect(range.maxLag).toBe(9000 + RECENTER_TRACK_WINDOW);
  });

  it("searches the full range while unlocked", () => {
    const range = recenterSearchRange(INITIAL_RECENTER_STATE, 16000);
    expect(range).toEqual({ minLag: 0, maxLag: 16000 });
  });
});

describe("applyRecenterShot", () => {
  it("locks on a trusted full-range peak and cold-restarts the taps", () => {
    const decision = applyRecenterShot(INITIAL_RECENTER_STATE, 9000, 0.4);
    expect(decision.state.locked).toBe(true);
    expect(decision.state.delay).toBe(9000);
    expect(decision.resetTaps).toBe(true);
  });

  it("ignores an untrusted peak entirely (the speech-alias guard)", () => {
    const decision = applyRecenterShot(INITIAL_RECENTER_STATE, 9320, 0.2);
    expect(decision.state).toEqual(INITIAL_RECENTER_STATE);
    expect(decision.resetTaps).toBe(false);
  });

  it("absorbs micro-shifts without moving the alignment", () => {
    const decision = applyRecenterShot(lockedAt(9000), 9005, 0.4);
    expect(decision.state.delay).toBe(9000);
    expect(decision.state.pendingCount).toBe(0);
  });

  it("moves only after two agreeing shots (hysteresis)", () => {
    const first = applyRecenterShot(lockedAt(9000), 9040, 0.4);
    expect(first.state.delay).toBe(9000); // one shot alone moves nothing
    expect(first.state.pendingCount).toBe(1);
    const second = applyRecenterShot(first.state, 9042, 0.4);
    expect(second.state.delay).toBe(9042);
    expect(second.state.pendingCount).toBe(0);
  });

  it("disagreing shots never accumulate", () => {
    const first = applyRecenterShot(lockedAt(9000), 9040, 0.4);
    const second = applyRecenterShot(first.state, 9180, 0.4);
    expect(second.state.pendingShift).toBe(180);
    expect(second.state.pendingCount).toBe(1);
    expect(second.state.delay).toBe(9000);
  });

  it("an untrusted shot clears a pending candidate", () => {
    const first = applyRecenterShot(lockedAt(9000), 9040, 0.4);
    const second = applyRecenterShot(first.state, 9044, 0.15);
    expect(second.state.pendingCount).toBe(0);
    expect(second.state.delay).toBe(9000);
  });
});

describe("modulatedNoise", () => {
  it("is deterministic per seed and carries the pitch envelope", () => {
    const amplitude = 0.25;
    const first = modulatedNoise(4800, 123, 150, 48000, amplitude);
    const second = modulatedNoise(4800, 123, 150, 48000, amplitude);
    expect(Array.from(first)).toEqual(Array.from(second));
    let loudest = 0;
    let quietest = amplitude;
    for (const sample of first) {
      const magnitude = Math.abs(sample);
      loudest = Math.max(loudest, magnitude);
      quietest = Math.min(quietest, magnitude);
    }
    // The 150 Hz envelope sweeps 0→1: near-inaudible troughs must exist (the
    // pitch-period structure that multi-peaks the correlation) and the ceiling holds.
    expect(loudest).toBeLessThanOrEqual(amplitude);
    expect(loudest).toBeGreaterThan(amplitude * 0.5);
    expect(quietest).toBeLessThan(amplitude * 0.1);
  });
});
