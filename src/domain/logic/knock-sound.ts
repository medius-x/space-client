/**
 * The voice-room join/leave knock (oak's tuned double "tuk … tuk"): two dry
 * thumps, joined going UP, left going DOWN, 80 ms apart. The 2026-11-19
 * retune history in three rounds: (1) the original — bare 150/210 Hz sines,
 * quiet, and in-game audio MASKED them completely (live reports); (2) the
 * retune to a brighter 200/270 + octave ring — audible, but read as TOO
 * HIGH (the low body that anchored the familiar pitch was gone); (3) the
 * OVERLAY the user asked for: the OLD 150/210 body stays the note's spine,
 * the brighter 200/270 layer ({@link KNOCK_BRIGHT_GAIN}) and its octave ring
 * ({@link KNOCK_OVERTONE_GAIN}) ride on top for the game-audible ring. Each
 * note: 3 ms attack, very fast exponential decay (τ=20 ms), 35 ms long.
 * The base register stays under the deafen cue's 280 Hz (tested); the layers
 * ride inside the same 35 ms decay, so the double-thump RHYTHM stays what
 * tells a knock from a cue. Pure schedule, testable without WebAudio.
 */

export interface KnockNote {
  /** The OLD low body's frequency (Hz) — the note's spine and perceived pitch. */
  frequencyHz: number;
  /** The brighter layer's frequency (Hz) — the ring's foundation. */
  brightHz: number;
  /** The octave partial's frequency (2× the bright layer) — the note's ring. */
  overtoneHz: number;
  /** Note start relative to the knock start, in seconds. */
  startSeconds: number;
  /** Note length in seconds. */
  durationSeconds: number;
}

export const KNOCK_NOTE_SECONDS = 0.035;
export const KNOCK_GAP_SECONDS = 0.08;
/** The bright layer's level relative to the low body. */
export const KNOCK_BRIGHT_GAIN = 0.6;
/** The octave partial's level relative to the low body. */
export const KNOCK_OVERTONE_GAIN = 0.35;
const LOW_FIRST_HZ = 150;
const LOW_SECOND_HZ = 210;
const BRIGHT_FIRST_HZ = 200;
const BRIGHT_SECOND_HZ = 270;

export function knockSchedule(direction: "join" | "leave"): KnockNote[] {
  const low = direction === "join" ? [LOW_FIRST_HZ, LOW_SECOND_HZ] : [LOW_SECOND_HZ, LOW_FIRST_HZ];
  const bright = direction === "join" ? [BRIGHT_FIRST_HZ, BRIGHT_SECOND_HZ] : [BRIGHT_SECOND_HZ, BRIGHT_FIRST_HZ];
  return low.map((frequencyHz, index) => ({
    frequencyHz,
    brightHz: bright[index]!,
    overtoneHz: bright[index]! * 2,
    startSeconds: index * (KNOCK_NOTE_SECONDS + KNOCK_GAP_SECONDS),
    durationSeconds: KNOCK_NOTE_SECONDS,
  }));
}
