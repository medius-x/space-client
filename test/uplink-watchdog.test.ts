import { describe, expect, it } from "vitest";
import { UplinkEscalation, UplinkStallDetector } from "../src/domain/logic/uplink-watchdog";

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

describe("UplinkEscalation (the stall ladder)", () => {
  it("climbs cheapest first: rebuild → recycle → rejoin ×2 → give-up forever", () => {
    const escalation = new UplinkEscalation();
    expect(escalation.next()).toBe("rebuild-noise");
    expect(escalation.next()).toBe("recycle-capture");
    expect(escalation.next()).toBe("rejoin");
    expect(escalation.next()).toBe("rejoin");
    // The ladder is EXHAUSTED: a wedged mic must not tear the room forever
    // (the live 2026-11-07 trace: 271 automatic rejoins in 90 minutes).
    expect(escalation.next()).toBe("give-up");
    expect(escalation.next()).toBe("give-up");
    expect(escalation.next()).toBe("give-up");
  });

  it("reset() (a MANUAL room entry, never the automatic rejoin's teardown) starts over", () => {
    const escalation = new UplinkEscalation();
    escalation.next();
    escalation.next();
    escalation.next();
    escalation.next();
    expect(escalation.next()).toBe("give-up");
    escalation.reset();
    expect(escalation.next()).toBe("rebuild-noise");
    expect(escalation.next()).toBe("recycle-capture");
  });
});
