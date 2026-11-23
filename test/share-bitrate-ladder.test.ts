import { describe, expect, it } from "vitest";
import {
  CPU_DOWNSCALE_STEPS,
  encoderCostOverloaded,
  encoderCostRelieved,
  initialCpuDownscaleState,
  initialLadderState,
  ladderConfigForPreset,
  nextCpuDownscale,
  nextLadderCeiling,
  type ShareLadderSignals,
  type ShareBitrateLadderState,
} from "../src/domain/logic/share-bitrate-ladder";

/** A quiet window with everything known. */
function quiet(nowMs: number, rttMs: number | null = 30): ShareLadderSignals {
  return { nowMs, rttMs, pliDelta: 0, congestionReports: 0, reportedLostPct: 0 };
}

describe("share bitrate ladder (the 8-Mbps freeze post-mortem, 2026-11-11)", () => {
  const config = ladderConfigForPreset(8_000_000);
  const start = initialLadderState(config);

  it("a preset is a ceiling, not the start: opens at 60% of it", () => {
    expect(start.ceilingBps).toBe(4_800_000);
    expect(config.floorBps).toBe(2_400_000); // 30% floor for an 8M preset
  });

  it("climbs on quiet windows in steps, never above the preset", () => {
    let state: ShareBitrateLadderState = start;
    // 800k steps for an 8M preset, at most one per 15 s (the 2026-11-23
    // desensitise): 4.8 → 5.6 → 6.4 → … → capped at 8.0
    const first = nextLadderCeiling(config, state, quiet(10_000));
    expect(first.ceilingBps).toBe(5_600_000);
    expect(first.change).toContain("up");
    state = first.state;
    for (let tick = 1; tick <= 10; tick += 1) {
      state = nextLadderCeiling(config, state, quiet(10_000 + tick * 10_000)).state;
    }
    expect(state.ceilingBps).toBe(8_000_000); // capped, not overshot
  });

  it("PLI growth cuts to ×0.7 and the hold window gates the climb back", () => {
    let state = nextLadderCeiling(config, start, quiet(10_000)).state; // 5.6M
    const cut = nextLadderCeiling(config, state, { ...quiet(15_000), pliDelta: 2 });
    expect(cut.ceilingBps).toBe(3_919_999); // 5.6M × 0.7 (floor of 3919999.999…)
    expect(cut.change).toContain("pli +2");
    state = cut.state;
    // A quiet window INSIDE the 45 s hold must not climb…
    const held = nextLadderCeiling(config, state, quiet(25_000));
    expect(held.ceilingBps).toBe(3_919_999);
    expect(held.change).toBeNull();
    // …while one after BOTH the 45 s hold and the 15 s up-interval climbs again.
    const resumed = nextLadderCeiling(config, state, quiet(75_000));
    expect(resumed.ceilingBps).toBe(4_719_999);
  });

  it("viewer congestion reports cut only on real loss (5% threshold, 2026-11-23)", () => {
    // 1.4% is Wi-Fi noise and even 4% chronic loss (NACK-healed, no freezes)
    // must not move the ceiling — only an actual problem cuts. The viewer's
    // honest freeze report (≥0.5 s) reads as 6% and stays above the bar.
    const noise = nextLadderCeiling(config, start, { ...quiet(10_000), congestionReports: 1, reportedLostPct: 1.4 });
    expect(noise.ceilingBps).toBe(5_600_000); // climbed as if quiet
    const chronic = nextLadderCeiling(config, noise.state, { ...quiet(80_000), congestionReports: 1, reportedLostPct: 4.0 });
    expect(chronic.ceilingBps).toBe(6_400_000); // climbed again — 4% alone is not congestion
    // Real viewer loss cuts hard.
    const cut = nextLadderCeiling(config, chronic.state, { ...quiet(100_000), congestionReports: 1, reportedLostPct: 6.0 });
    expect(cut.ceilingBps).toBe(4_480_000); // 6.4M × 0.7
    expect(cut.change).toContain("viewers lost 6.0%");
  });

  it("RTT growth over the session baseline cuts early; congested readings never raise the baseline", () => {
    // Learn a 30 ms baseline on quiet windows…
    let state = nextLadderCeiling(config, start, quiet(10_000, 30)).state;
    expect(state.baseRttMs).toBe(30);
    // …then the queue fills: 220 ms reads as congestion at a 150 ms threshold.
    const cut = nextLadderCeiling(config, state, quiet(15_000, 220));
    expect(cut.ceilingBps).toBeLessThan(state.ceilingBps);
    expect(cut.change).toContain("rtt 220 ms");
    expect(cut.state.baseRttMs).toBe(30); // the 220 ms reading did NOT raise it
    // A slow-but-stable link (no growth over the learned baseline) stays
    // quiet — past the hold it even climbs, never cuts on RTT again.
    const stable = nextLadderCeiling(config, state, quiet(70_000, 170));
    expect(stable.change).not.toContain("rtt");
  });

  it("one incident never cuts twice — the copycat cut waits out the cooldown (2026-11-23)", () => {
    let state = nextLadderCeiling(config, start, quiet(10_000)).state; // 5.6M
    const first = nextLadderCeiling(config, state, { ...quiet(15_000), pliDelta: 3 });
    expect(first.ceilingBps).toBe(3_919_999); // the first cut fires
    // 5 s later the SAME incident is still reporting (every signal at once) —
    // the self-reinforcing second cut of the live log is BLOCKED here.
    const blocked = nextLadderCeiling(config, first.state, {
      ...quiet(20_000), pliDelta: 3, congestionReports: 1, reportedLostPct: 6.0,
    });
    expect(blocked.ceilingBps).toBe(3_919_999);
    expect(blocked.change).toBeNull();
    // a problem that is STILL real after the 10 s cooldown cuts again
    const later = nextLadderCeiling(config, first.state, { ...quiet(26_000), pliDelta: 3 });
    expect(later.ceilingBps).toBeLessThan(3_919_999);
  });

  it("repeated cuts bottom out at the floor", () => {
    let state: ShareBitrateLadderState = start;
    for (let round = 0; round < 10; round += 1) {
      state = nextLadderCeiling(config, state, { ...quiet(round * 10_000), pliDelta: 5 }).state;
    }
    expect(state.ceilingBps).toBe(config.floorBps);
  });
});

describe("cpu downscale stepper (the encoder-cannot-keep-up axis)", () => {
  it("two consecutive overloaded windows step the scale UP, one does not", () => {
    let state = initialCpuDownscaleState();
    const first = nextCpuDownscale(state, true, false);
    expect(first.change).toBeNull(); // one window alone never moves it
    state = first.state;
    const second = nextCpuDownscale(state, true, false);
    expect(second.factor).toBe(CPU_DOWNSCALE_STEPS[1]); // ÷1.25
    expect(second.change).toContain("encoder behind");
  });

  it("a borderline window between overloads breaks the streak (strictly consecutive)", () => {
    let state = initialCpuDownscaleState();
    state = nextCpuDownscale(state, true, false).state;
    state = nextCpuDownscale(state, false, false).state; // borderline resets the streak
    const notYet = nextCpuDownscale(state, true, false);
    expect(notYet.change).toBeNull();
  });

  it("four consecutive relieved windows step it back, and the floor step is no-downscale", () => {
    let state = initialCpuDownscaleState();
    state = nextCpuDownscale(nextCpuDownscale(state, true, false).state, true, false).state; // ÷1.25
    // relief below the top step does nothing…
    state = nextCpuDownscale(state, false, true).state;
    state = nextCpuDownscale(state, false, true).state;
    state = nextCpuDownscale(state, false, true).state;
    const back = nextCpuDownscale(state, false, true); // 4th relieved window
    expect(back.factor).toBe(CPU_DOWNSCALE_STEPS[0]); // ÷1 — recovered
    expect(back.change).toContain("caught up");
    const idle = nextCpuDownscale(back.state, false, true); // nothing to recover
    expect(idle.change).toBeNull();
  });

  it("repeated overloads bottom out at the most aggressive step", () => {
    let state = initialCpuDownscaleState();
    for (let round = 0; round < 20; round += 1) {
      state = nextCpuDownscale(state, true, false).state;
    }
    expect(state.stepIndex).toBe(CPU_DOWNSCALE_STEPS.length - 1);
  });
});

describe("encoder cost verdicts (the 2026-11-19 static-content rework)", () => {
  // 30 fps input → a 33.3 ms frame budget: overloaded ≥ 26.7, relieved ≤ 16.7.
  it("a saturated encoder (cost eating the frame budget) reads as overloaded", () => {
    expect(encoderCostOverloaded(27, 30)).toBe(true);
    expect(encoderCostOverloaded(90, 30)).toBe(true); // the 11-11 "enc 11 fps" shape
  });

  it("a still screen encodes few CHEAP frames — relief, never overload (the regression)", () => {
    // The 2026-11-18 logs: the old fps-ratio detector fired "encoder behind"
    // on static content at a healthy 7-8 ms/f and reverted 20 s later.
    expect(encoderCostOverloaded(8, 30)).toBe(false);
    expect(encoderCostRelieved(8, 30)).toBe(true);
  });

  it("a borderline cost window is neither overloaded nor relieved", () => {
    expect(encoderCostOverloaded(20, 30)).toBe(false);
    expect(encoderCostRelieved(20, 30)).toBe(false);
  });

  it("a window with no encoded frames, or an unknown input rate, is borderline", () => {
    expect(encoderCostOverloaded(null, 30)).toBe(false);
    expect(encoderCostRelieved(null, 30)).toBe(false);
    expect(encoderCostOverloaded(90, null)).toBe(false);
    expect(encoderCostRelieved(90, null)).toBe(false);
  });
});
