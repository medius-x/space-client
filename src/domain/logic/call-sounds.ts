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

/** Bell partials 1 : 1.5 : 2.5 over C6 — fundamental, fifth, sparkle. */
export const CHIME_PARTIALS_HZ = [1_046.5, 1_568.0, 2_637.0];
export const CHIME_PARTIAL_GAINS = [1, 0.5, 0.25];
export const CHIME_DURATION_SECONDS = 2.6;
