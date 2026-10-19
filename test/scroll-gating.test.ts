import { describe, expect, it } from "vitest";
import { ScrollSignalGate } from "../src/domain/logic/scroll-gating";

const OPTIONS = {
  nearTopThreshold: 2500,
  nearBottomThreshold: 80,
  bottomReassertMs: 250,
  nearTopMinIntervalMs: 250,
};

function geometryOf(scrollTop: number, totalSize = 5000, viewportHeight = 600) {
  return { scrollTop, totalSize, viewportHeight };
}

function freshGate(): ScrollSignalGate {
  return new ScrollSignalGate(OPTIONS);
}

describe("ScrollSignalGate near-top pacing", () => {
  it("fires in the zone, suppresses inside the interval, re-fires after it", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(100), 1000).fireNearTop).toBe(true);
    expect(gate.onNext(geometryOf(200), 1100).fireNearTop).toBe(false);
    expect(gate.onNext(geometryOf(300), 1249).fireNearTop).toBe(false);
    expect(gate.onNext(geometryOf(400), 1250).fireNearTop).toBe(true);
  });

  it("keeps firing at the floor cadence while the stream stays in-zone (back-fill invariant)", () => {
    const gate = freshGate();
    let fired = 0;
    for (let timeMs = 0; timeMs < 3000; timeMs += 16) {
      if (gate.onNext(geometryOf(100), timeMs).fireNearTop) {
        fired += 1;
      }
    }
    // ~3000 ms of a continuous 60 Hz in-zone stream: the pacer spaces the
    // attempts to ≥250 ms (≤12 fires) but must keep paginating (≥10).
    expect(fired).toBeGreaterThanOrEqual(10);
    expect(fired).toBeLessThanOrEqual(12);
  });

  it("a list that barely exceeds the viewport never paginates", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(0, 650, 600), 0).fireNearTop).toBe(false); // 650 ≤ 600+100
    expect(gate.onNext(geometryOf(0, 701, 600), 0).fireNearTop).toBe(true);
  });

  it("below the threshold is out of the zone", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(2500), 0).fireNearTop).toBe(false);
    expect(gate.onNext(geometryOf(2499), 0).fireNearTop).toBe(true);
  });

  it("re-entry after leaving the zone fires immediately (no lingering pace)", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(100), 1000).fireNearTop).toBe(true);
    expect(gate.onNext(geometryOf(3000), 1100).fireNearTop).toBe(false); // out of zone
    expect(gate.onNext(geometryOf(200), 1150).fireNearTop).toBe(true); // 150 ms later, still fires
  });

  it("reset clears the pacing history", () => {
    const gate = freshGate();
    gate.onNext(geometryOf(100), 1000);
    gate.reset();
    expect(gate.onNext(geometryOf(100), 1100).fireNearTop).toBe(true);
  });
});

describe("ScrollSignalGate bottom-proximity edges and re-asserts", () => {
  it("fires on transitions in both directions and re-asserts while pinned", () => {
    const gate = freshGate();
    // max scrollTop = 5000-600 = 4400; "near the bottom" = within 80 of it.
    expect(gate.onNext(geometryOf(4400), 0).fireBottomProximity).toBe(true); // false→true edge
    expect(gate.onNext(geometryOf(4401), 100).fireBottomProximity).toBe(false); // pinned, re-assert not due
    expect(gate.onNext(geometryOf(4402), 250).fireBottomProximity).toBe(true); // re-assert (250 ≥ 250)
    expect(gate.onNext(geometryOf(1000), 400).fireBottomProximity).toBe(true); // true→false edge fires
    expect(gate.onNext(geometryOf(2000), 500).fireBottomProximity).toBe(false); // continuously far — silent
  });

  it("reports the current level alongside the fire decision", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(4400), 0).bottomProximity).toBe(true);
    expect(gate.onNext(geometryOf(1000), 10).bottomProximity).toBe(false);
  });

  it("the near-bottom boundary is the threshold itself", () => {
    const gate = freshGate();
    expect(gate.onNext(geometryOf(4400), 0).bottomProximity).toBe(true); // 5000-4400-600 = 0
    expect(gate.onNext(geometryOf(4320), 10).bottomProximity).toBe(false); // 5000-4320-600 = 80, not < 80
    expect(gate.onNext(geometryOf(4321), 20).bottomProximity).toBe(true); // 79 < 80
  });
});
