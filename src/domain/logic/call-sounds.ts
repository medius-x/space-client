/**
 * Call sounds, transplanted from oak's tuned syntheses. Both are PURE schedules —
 * the WebAudio synthesis lives in notifications.ts.
 *
 * RINGBACK (heard by the CALLER while the callee's phone "rings"): a two-tone
 * 440+480 Hz burst of 1.8 s followed by 1.2 s of silence — one 3 s looped cycle
 * (the classic dual-tone ringback cadence).
 *
 * CHIME (heard by the CALLEE, ONCE per incoming call): three bell partials with a
 * shared exponential decay — a long fading "dinnnng", not a repeating ring.
 */

export const RINGBACK_TONE_HZ = [440, 480];
export const RINGBACK_BURST_SECONDS = 1.8;
export const RINGBACK_PAUSE_SECONDS = 1.2;

export function ringbackCycleSeconds(): number {
  return RINGBACK_BURST_SECONDS + RINGBACK_PAUSE_SECONDS;
}

/** oak's CallChime: three bell partials over C6 — 1046.5 / 1570.9 / 2616.3 Hz,
 *  amplitudes 0.25 / 0.12 / 0.06 — sharing ONE exponential decay τ = 0.55 s. */
export const CHIME_PARTIALS_HZ = [1_046.5, 1_570.9, 2_616.3];
export const CHIME_PARTIAL_GAINS = [0.25, 0.12, 0.06];
export const CHIME_DURATION_SECONDS = 2.6;
/** The shared exponential-decay time constant (oak's per-sample e^(-t/τ) envelope). */
export const CHIME_DECAY_TAU_S = 0.55;
