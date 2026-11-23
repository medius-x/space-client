/**
 * The hotkey voice-state cues (user decision 2026-09-18): a single continuous
 * frequency SWEEP — rising when the state comes back, falling when it engages —
 * so the user knows the state WITHOUT looking (they are in a game; the window
 * has no focus and no toast is shown). Mute and deafen are the SAME shape in
 * DIFFERENT registers (deafen lower — user request), and both are deliberately
 * unlike the voice-room join/leave knock: the knock is two dry discrete thumps
 * at 150/210 Hz; the cues are gliding tones (mute 500–900 Hz, deafen 280–480 Hz
 * — three pairwise non-overlapping registers, tested). Pure data so the
 * parameters are testable without WebAudio.
 */

export interface VoiceCue {
  /** The glide's start frequency in Hz. */
  fromHz: number;
  /** The glide's end frequency in Hz (higher than fromHz when engaging=false). */
  toHz: number;
  durationSeconds: number;
  attackSeconds: number;
  /** Master gain (the envelope peaks at 1.0 under it). */
  gain: number;
}

const CUE_DURATION_SECONDS = 0.12;
const CUE_ATTACK_SECONDS = 0.005;
const CUE_GAIN = 0.35;

const MUTE_LOW_HZ = 500;
const MUTE_HIGH_HZ = 900;
const DEAFEN_LOW_HZ = 280;
const DEAFEN_HIGH_HZ = 480;

function sweep(lowHz: number, highHz: number, engaged: boolean): VoiceCue {
  return {
    fromHz: engaged ? highHz : lowHz,
    toHz: engaged ? lowHz : highHz,
    durationSeconds: CUE_DURATION_SECONDS,
    attackSeconds: CUE_ATTACK_SECONDS,
    gain: CUE_GAIN,
  };
}

/** Unmute rises, mute falls — the direction IS the message. */
export function muteCue(muted: boolean): VoiceCue {
  return sweep(MUTE_LOW_HZ, MUTE_HIGH_HZ, muted);
}

/** The deafen twin, one register lower (user request) — same direction rule. */
export function deafenCue(deafened: boolean): VoiceCue {
  return sweep(DEAFEN_LOW_HZ, DEAFEN_HIGH_HZ, deafened);
}
