/**
 * Recentering policy for the share-audio subtractor (#483 smoke fix): the
 * cross-correlation on SPEECH is multi-peaked (quasi-periodicity — aliases every
 * pitch period, ~240–480 samples), and blindly chasing the global maximum jumped
 * between aliases: taps converged for one alignment kept sliding to another, and
 * the misaligned subtraction was heard as warble/grinding, with L and R locking
 * different aliases (the stereo image leaning to one ear — live smoke 2026-09-18).
 *
 * The measured path delay is STABLE within a session (no drift), so the policy is
 * stability-first: lock once on a trusted peak, then only ever search a narrow
 * window around the lock (pitch aliases fall outside it), move only on hysteresis
 * (two agreeing shots), and give the lock up only when cancellation persistently
 * fails (the caller's failure detector). The worklet in media/share-subtraction.ts
 * carries a HAND-SYNCED COPY (keep in sync) and computes the correlation on the
 * L+R mono sum, applying ONE delay to both channels.
 */

/** Quality gate for the initial full-range lock (wrong locks are THE bug — demand trust). */
export const RECENTER_LOCK_QUALITY = 0.3;
/** Quality gate for tracking adjustments while locked. */
export const RECENTER_TRACK_QUALITY = 0.25;
/** While locked, the peak search stays within delay ± this many samples. */
export const RECENTER_TRACK_WINDOW = 256;
/** Shifts up to this are absorbed by the NLMS — no alignment move at all. */
export const RECENTER_IGNORE_SHIFT = 8;
/** Two consecutive shots agreeing within this many samples count as one decision. */
export const RECENTER_HYSTERESIS_SLACK = 16;

export interface RecenterState {
  delay: number;
  locked: boolean;
  pendingShift: number;
  pendingCount: number;
}

export const INITIAL_RECENTER_STATE: RecenterState = {
  delay: 512,
  locked: false,
  pendingShift: 0,
  pendingCount: 0,
};

/** The lag range the correlation peak search should cover for the next shot. */
export function recenterSearchRange(state: RecenterState, maxLag: number): { minLag: number; maxLag: number } {
  if (!state.locked) {
    return { minLag: 0, maxLag };
  }
  return {
    minLag: Math.max(0, state.delay - RECENTER_TRACK_WINDOW),
    maxLag: Math.min(maxLag, state.delay + RECENTER_TRACK_WINDOW),
  };
}

export interface RecenterDecision {
  state: RecenterState;
  /** Cold-restart the adaptive taps (an initial lock lands far from any prior state). */
  resetTaps: boolean;
}

/** Fold one correlation shot (best lag + its quality) into the shared state. */
export function applyRecenterShot(state: RecenterState, peakLag: number, peakQuality: number): RecenterDecision {
  const cleared: RecenterState = { ...state, pendingShift: 0, pendingCount: 0 };
  if (peakQuality < (state.locked ? RECENTER_TRACK_QUALITY : RECENTER_LOCK_QUALITY)) {
    return { state: cleared, resetTaps: false }; // an untrusted shot must not move anything
  }
  if (!state.locked) {
    return {
      state: { delay: Math.max(0, peakLag), locked: true, pendingShift: 0, pendingCount: 0 },
      resetTaps: true,
    };
  }
  const shift = peakLag - state.delay;
  if (Math.abs(shift) <= RECENTER_IGNORE_SHIFT) {
    return { state: cleared, resetTaps: false };
  }
  const agreesWithPending = state.pendingCount > 0 && Math.abs(shift - state.pendingShift) <= RECENTER_HYSTERESIS_SLACK;
  const pendingShift = shift;
  const pendingCount = agreesWithPending ? state.pendingCount + 1 : 1;
  if (pendingCount >= 2) {
    // Two agreeing shots: a real micro-drift, not a speech alias — move WITH the
    // taps (the impulse stays inside the ±HALF tap window; the NLMS re-migrates it).
    return {
      state: { delay: state.delay + pendingShift, locked: true, pendingShift: 0, pendingCount: 0 },
      resetTaps: false,
    };
  }
  return { state: { ...state, pendingShift, pendingCount }, resetTaps: false };
}

/**
 * A speech-likeness probe for the self-test: LCG noise under a pitch-rate
 * envelope — the correlation is multi-peaked exactly like voiced speech, which is
 * what made the global-maximum tracker jump (the bug this module fixes).
 */
export function modulatedNoise(count: number, seedValue: number, pitchHz: number, sampleRate: number, amplitude = 0.25): Float32Array {
  const samples = new Float32Array(count);
  let seed = seedValue >>> 0;
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    const noise = (seed / 0xffff_ffff - 0.5) * 2 * amplitude;
    const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * pitchHz * index) / sampleRate);
    samples[index] = noise * envelope;
  }
  return samples;
}
