/**
 * The publisher's adaptive share-video bitrate ladder (2026-11-11, the
 * 8-Mbps freeze post-mortem): a picked quality preset is a CEILING, not a
 * constant — the friend's uplink proved narrower than the preset, the queue
 * filled for minutes ("smooth at first, then freezing"), and drop-tail losses
 * plus PLI→keyframe avalanches produced multi-second viewer freezes while the
 * encoder happily kept the requested 7-8 Mbps (it never sees downstream loss;
 * Janus vanilla-forwarding feeds it no transport-cc, and the REMB it does get
 * is our own static number).
 *
 * AIMD: start below the preset, climb while the channel is quiet, cut hard on
 * the first congestion signal. Signals, in reliability order:
 *  - VIEWER CONGESTION REPORTS (the viewer-side loss the publisher cannot see
 *    itself, relayed via the server — the share-congestion capability);
 *  - PLI growth (a viewer's decoder lost the delta chain — already relayed by
 *    Janus, works everywhere);
 *  - RTT growth over the session's baseline (the uplink queue filling — the
 *    EARLIEST signal, it precedes loss).
 * Pure logic, clock injected: the runtime owns the timers and the stats poll.
 */

export interface ShareBitrateLadderConfig {
  /** The quality preset's maximum, bps — the ladder never exceeds it. */
  presetBps: number;
  /** Never adapt below this (bps). */
  floorBps: number;
  /** The opening ceiling, bps — below the preset, from the first frame. */
  startBps: number;
  /** The quiet-channel climb step, bps. */
  upStepBps: number;
  /** How long a freshly-lowered ceiling must hold before climbing resumes. */
  holdAfterDownMs: number;
  /** The multiplicative cut on a congestion signal. */
  downFactor: number;
  /** RTT growth over the session baseline that reads as a filling queue. */
  rttGrowMs: number;
  /** PLI arrivals in one window that read as congestion. */
  pliThreshold: number;
  /** Viewer-reported loss percent in one window that reads as congestion. */
  reportedLostPctThreshold: number;
}

/** One evaluation window's inputs (all deltas computed by the caller). */
export interface ShareLadderSignals {
  nowMs: number;
  /** Current publisher→SFU RTT, ms (null = no candidate-pair stat this tick). */
  rttMs: number | null;
  /** PLIs received from viewers over the window. */
  pliDelta: number;
  /** Viewer congestion reports over the window (each already loss-gated). */
  congestionReports: number;
  /** The worst reported loss percent over the window (0 when none). */
  reportedLostPct: number;
}

export interface ShareBitrateLadderState {
  ceilingBps: number;
  /** The last DOWN move's timestamp (hold-window bookkeeping). */
  lastDownAtMs: number;
  /** The session's RTT baseline: the minimum seen while quiet (null until the
   *  first quiet reading — growth is only meaningful against it). */
  baseRttMs: number | null;
}

export interface LadderVerdict {
  ceilingBps: number;
  state: ShareBitrateLadderState;
  /** Human-readable move for the log; null when nothing changed. */
  change: string | null;
}

/** The picker-preset-derived defaults (the presets the SharePicker offers). */
export function ladderConfigForPreset(presetBps: number): ShareBitrateLadderConfig {
  const floorBps = Math.max(500_000, Math.floor(presetBps * 0.3));
  return {
    presetBps,
    floorBps,
    startBps: Math.floor(presetBps * 0.6),
    upStepBps: Math.max(300_000, Math.floor(presetBps * 0.1)),
    holdAfterDownMs: 15_000,
    downFactor: 0.7,
    rttGrowMs: 150,
    pliThreshold: 2,
    reportedLostPctThreshold: 0.5,
  };
}

/** True when the window shows no congestion (the quiet the climb needs). */
function isQuietWindow(config: ShareBitrateLadderConfig, signals: ShareLadderSignals): boolean {
  if (signals.congestionReports > 0 && signals.reportedLostPct >= config.reportedLostPctThreshold) {
    return false;
  }
  if (signals.pliDelta >= config.pliThreshold) {
    return false;
  }
  return true; // RTT alone never blocks a climb — only triggers a cut
}

export function nextLadderCeiling(
  config: ShareBitrateLadderConfig,
  state: ShareBitrateLadderState,
  signals: ShareLadderSignals,
): LadderVerdict {
  // The RTT baseline: learned from quiet windows only (a congested reading
  // must not raise the bar the growth check compares against).
  let baseRttMs = state.baseRttMs;
  const rttKnown = signals.rttMs !== null && signals.rttMs > 0;
  const quiet = isQuietWindow(config, signals);
  if (rttKnown && quiet && (baseRttMs === null || signals.rttMs! < baseRttMs)) {
    baseRttMs = signals.rttMs!;
  }

  // Congestion: any of the three signals fires a cut.
  const rttCongested = rttKnown && baseRttMs !== null && signals.rttMs! > baseRttMs + config.rttGrowMs;
  const pliCongested = signals.pliDelta >= config.pliThreshold;
  const reportedCongested = signals.congestionReports > 0 && signals.reportedLostPct >= config.reportedLostPctThreshold;
  if (pliCongested || reportedCongested || rttCongested) {
    const lowered = Math.max(config.floorBps, Math.floor(state.ceilingBps * config.downFactor));
    if (lowered < state.ceilingBps) {
      const reason = pliCongested
        ? `pli +${signals.pliDelta}`
        : reportedCongested
          ? `viewers lost ${signals.reportedLostPct.toFixed(1)}%`
          : `rtt ${Math.round(signals.rttMs!)} ms > ${Math.round(baseRttMs ?? 0)}+${config.rttGrowMs}`;
      return {
        ceilingBps: lowered,
        state: { ceilingBps: lowered, lastDownAtMs: signals.nowMs, baseRttMs },
        change: `down → ${(lowered / 1_000_000).toFixed(1)} Mbps (${reason})`,
      };
    }
    // Already at the floor — nothing to cut, the hold still applies.
    return { ceilingBps: state.ceilingBps, state: { ...state, baseRttMs }, change: null };
  }

  // Quiet: climb, but never during the post-cut hold (let the queue drain and
  // the viewers heal before pushing again).
  if (quiet && signals.nowMs - state.lastDownAtMs >= config.holdAfterDownMs
      && state.ceilingBps < config.presetBps) {
    const raised = Math.min(config.presetBps, state.ceilingBps + config.upStepBps);
    return {
      ceilingBps: raised,
      state: { ceilingBps: raised, lastDownAtMs: state.lastDownAtMs, baseRttMs },
      change: `up → ${(raised / 1_000_000).toFixed(1)} Mbps (quiet)`,
    };
  }
  return { ceilingBps: state.ceilingBps, state: { ...state, baseRttMs }, change: null };
}

export function initialLadderState(config: ShareBitrateLadderConfig): ShareBitrateLadderState {
  return { ceilingBps: config.startBps, lastDownAtMs: Number.NEGATIVE_INFINITY, baseRttMs: null };
}

// ---------------------------------------------------------------------------
// The CPU axis (2026-11-11, the same post-mortem): a share preset the ENCODER
// cannot sustain (the live log's "enc 11 fps < 30 in fps" — a 1440p window on
// a busy machine) freezes into frame drops no bitrate ladder can cure — the
// bottleneck is local CPU, not the channel. The lever is the sender's
// scaleResolutionDownBy: the capture stays full-size, the encoder codes a
// downscaled copy (the scaler is cheap; the encode cost drops quadratically).
// The stepper moves in fixed steps with HYSTERESIS: two consecutive overloaded
// windows step the scale UP (more aggressive), four consecutive relieved
// windows step it back DOWN (recovery) — a single noisy window never moves it.
// ---------------------------------------------------------------------------

/** The downscale ladder, small-to-aggressive; index 0 = no downscale. */
export const CPU_DOWNSCALE_STEPS: readonly number[] = [1, 1.25, 1.5, 2];

export interface CpuDownscaleState {
  stepIndex: number;
  /** Consecutive overloaded windows (resets on relief). */
  overloadedWindows: number;
  /** Consecutive relieved windows (resets on overload). */
  relievedWindows: number;
}

export interface CpuDownscaleVerdict {
  factor: number;
  state: CpuDownscaleState;
  /** Human-readable move for the log; null when nothing changed. */
  change: string | null;
}

export function initialCpuDownscaleState(): CpuDownscaleState {
  return { stepIndex: 0, overloadedWindows: 0, relievedWindows: 0 };
}

// ---------------------------------------------------------------------------
// The overload verdict's INPUT (2026-11-19 rework): the original fps-ratio
// detector (window encoded fps < 75% of the capture input fps) misread STILL
// screens as overload — a static capture legitimately encodes far fewer frames
// than the input rate, whatever the CPU (the 2026-11-18 logs: the stepper
// fired "encoder behind" at a healthy 7-8 ms/f and reverted 20 s later, three
// times in ten minutes). The load signal still content cannot fake is the
// per-frame ENCODE COST against the frame budget (1000/inputFps): a saturated
// encoder spends most of the budget on every frame; a static screen encodes
// few, CHEAP frames. A window with no encoded frames (or an unknown input
// rate) is borderline — no counter moves.
// ---------------------------------------------------------------------------

/** Overloaded: the per-frame encode cost eats ≥ 80% of the frame budget — the
 *  encoder is saturating toward below-realtime encode rates. */
export function encoderCostOverloaded(perFrameMs: number | null, inputFps: number | null): boolean {
  if (perFrameMs === null || inputFps === null || inputFps <= 0) {
    return false;
  }
  return perFrameMs >= (1000 / inputFps) * 0.8;
}

/** Relieved: the per-frame encode cost sits at ≤ 50% of the frame budget —
 *  comfortable margin, the recovery condition for stepping the scale back. */
export function encoderCostRelieved(perFrameMs: number | null, inputFps: number | null): boolean {
  if (perFrameMs === null || inputFps === null || inputFps <= 0) {
    return false;
  }
  return perFrameMs <= (1000 / inputFps) * 0.5;
}

/** One window's verdict: `overloaded` = the encoder fell meaningfully behind
 *  its input (the "encoder cannot keep up" condition), `relieved` = it keeps
 *  up with margin. A window may be neither (borderline) — no counter moves. */
export function nextCpuDownscale(
  state: CpuDownscaleState,
  overloaded: boolean,
  relieved: boolean,
): CpuDownscaleVerdict {
  if (overloaded) {
    const overloadedWindows = state.overloadedWindows + 1;
    if (overloadedWindows >= 2 && state.stepIndex < CPU_DOWNSCALE_STEPS.length - 1) {
      const stepIndex = state.stepIndex + 1;
      return {
        factor: CPU_DOWNSCALE_STEPS[stepIndex]!,
        state: { stepIndex, overloadedWindows: 0, relievedWindows: 0 },
        change: `cpu downscale → ÷${CPU_DOWNSCALE_STEPS[stepIndex]} (encoder behind)`,
      };
    }
    return { factor: CPU_DOWNSCALE_STEPS[state.stepIndex]!, state: { ...state, overloadedWindows, relievedWindows: 0 }, change: null };
  }
  if (relieved && state.stepIndex > 0) {
    const relievedWindows = state.relievedWindows + 1;
    if (relievedWindows >= 4) {
      const stepIndex = state.stepIndex - 1;
      return {
        factor: CPU_DOWNSCALE_STEPS[stepIndex]!,
        state: { stepIndex, overloadedWindows: 0, relievedWindows: 0 },
        change: `cpu downscale → ÷${CPU_DOWNSCALE_STEPS[stepIndex]} (caught up)`,
      };
    }
    return { factor: CPU_DOWNSCALE_STEPS[state.stepIndex]!, state: { ...state, overloadedWindows: 0, relievedWindows }, change: null };
  }
  // A borderline window resets nothing but never advances anything either.
  return { factor: CPU_DOWNSCALE_STEPS[state.stepIndex]!, state: { ...state, overloadedWindows: 0, relievedWindows: 0 }, change: null };
}
