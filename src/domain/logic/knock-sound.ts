/**
 * The voice-room join/leave knock (oak's tuned double "tuk … tuk"): two dry
 * thumps, joined going UP (150→210 Hz), left going DOWN (210→150 Hz). Each
 * note is a bare sine — 3 ms attack, very fast exponential decay (τ=20 ms),
 * 35 ms long — with an 80 ms gap between the two. Pure schedule so the
 * synthesis parameters are testable without WebAudio.
 */

export interface KnockNote {
  /** Sine frequency in Hz. */
  frequencyHz: number;
  /** Note start relative to the knock start, in seconds. */
  startSeconds: number;
  /** Note length in seconds. */
  durationSeconds: number;
}

export const KNOCK_NOTE_SECONDS = 0.035;
export const KNOCK_GAP_SECONDS = 0.08;
const JOIN_FIRST_HZ = 150;
const JOIN_SECOND_HZ = 210;

export function knockSchedule(direction: "join" | "leave"): KnockNote[] {
  const frequencies = direction === "join" ? [JOIN_FIRST_HZ, JOIN_SECOND_HZ] : [JOIN_SECOND_HZ, JOIN_FIRST_HZ];
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    startSeconds: index * (KNOCK_NOTE_SECONDS + KNOCK_GAP_SECONDS),
    durationSeconds: KNOCK_NOTE_SECONDS,
  }));
}
