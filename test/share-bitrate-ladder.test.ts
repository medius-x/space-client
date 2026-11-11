import { describe, expect, it } from "vitest";
import {
  CPU_DOWNSCALE_STEPS,
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
    // 800k steps for an 8M preset: 4.8 → 5.6 → 6.4 → … → capped at 8.0
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
    // A quiet window INSIDE the 15 s hold must not climb…
    const held = nextLadderCeiling(config, state, quiet(25_000));
    expect(held.ceilingBps).toBe(3_919_999);
    expect(held.change).toBeNull();
    // …while one AFTER the hold climbs again.
    const resumed = nextLadderCeiling(config, state, quiet(31_000));
    expect(resumed.ceilingBps).toBe(4_719_999);
  });

  it("viewer congestion reports cut when the reported loss is real", () => {
    const cut = nextLadderCeiling(config, start, { ...quiet(10_000), congestionReports: 1, reportedLostPct: 1.4 });
    expect(cut.ceilingBps).toBe(3_360_000); // 4.8 × 0.7
    expect(cut.change).toContain("viewers lost 1.4%");
    // A report below the loss threshold is noise: no cut (it may still climb).
    const noise = nextLadderCeiling(config, cut.state, { ...quiet(30_000), congestionReports: 1, reportedLostPct: 0.1 });
    expect(noise.ceilingBps).toBe(3_360_000 + 800_000); // climbed: the report did not gate
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
    // A slow-but-stable link (no growth over the learned baseline) stays quiet.
    const stable = nextLadderCeiling(config, state, quiet(30_000, 170));
    expect(stable.change).not.toContain("rtt");
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
