import { describe, expect, it } from "vitest";
import { UplinkStallDetector } from "../src/domain/logic/uplink-watchdog";

describe("UplinkStallDetector (publish-side mic watchdog)", () => {
  it("fires on the second consecutive zero-growth sample, then re-arms", () => {
    const detector = new UplinkStallDetector();
    expect(detector.sample(1000, true)).toBe(false); // baseline
    expect(detector.sample(1000, true)).toBe(false); // stall streak 1
    expect(detector.sample(1000, true)).toBe(true); // streak 2 → CONFIRMED
    expect(detector.sample(1000, true)).toBe(false); // re-armed: needs another pair
    expect(detector.sample(1000, true)).toBe(true);
  });

  it("growth — even of one byte — means RTP is flowing: never fires", () => {
    const detector = new UplinkStallDetector();
    expect(detector.sample(1000, true)).toBe(false);
    expect(detector.sample(1001, true)).toBe(false);
    expect(detector.sample(5000, true)).toBe(false);
    expect(detector.sample(5001, true)).toBe(false);
  });

  it("a muted track pauses the detector (no RTP is legitimate)", () => {
    const detector = new UplinkStallDetector();
    expect(detector.sample(1000, true)).toBe(false);
    expect(detector.sample(1000, false)).toBe(false); // muted mid-streak
    expect(detector.sample(1000, true)).toBe(false); // fresh baseline after unmute
    expect(detector.sample(1000, true)).toBe(false); // streak 1 of a NEW watch
    expect(detector.sample(1000, true)).toBe(true);
  });

  it("a missing stats sample is inert (baseline reset), not a stall", () => {
    const detector = new UplinkStallDetector();
    expect(detector.sample(1000, true)).toBe(false);
    expect(detector.sample(null, true)).toBe(false); // stats hiccup
    expect(detector.sample(1000, true)).toBe(false); // baseline again
    expect(detector.sample(1000, true)).toBe(false);
    expect(detector.sample(1000, true)).toBe(true); // two IN-AROW frozen samples still confirm
  });

  it("reset() forgets the baseline (a track swap starts a new watch)", () => {
    const detector = new UplinkStallDetector();
    expect(detector.sample(1000, true)).toBe(false);
    detector.reset();
    expect(detector.sample(1000, true)).toBe(false); // baseline, not a stall
    expect(detector.sample(1000, true)).toBe(false);
    expect(detector.sample(1000, true)).toBe(true);
  });
});
