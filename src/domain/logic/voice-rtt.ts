/**
 * Media-path RTT for the voice badge (user decision 2026-10-15): whole
 * milliseconds from a WebRTC stats report — the nominated succeeded candidate
 * pair's currentRoundTripTime. This is the MEDIA transport (client ↔ SFU),
 * deliberately distinct from the STOMP ping badge (signalling path): a room
 * can be green on signalling while its media path is dead, which is exactly
 * the confusion the packaged smoke lived 2026-10-14.
 */

/** The candidate-pair fields the picker reads — the live RTCStatsReport is
 *  duck-typed down to this (an RTCIceCandidatePairStats subset). */
export interface CandidatePairEntry {
  type: string;
  state?: string;
  nominated?: boolean;
  currentRoundTripTime?: number;
}

/** Whole-millisecond RTT of the nominated succeeded pair; falls back to the
 *  first succeeded pair with a finite value (some stacks leave `nominated`
 *  unset on vanilla-ICE pairs). Null when the transport has no usable pair
 *  yet (connecting/reconnecting) or every value is garbage — the badge then
 *  renders without the number. */
export function voiceRttMillis(pairs: CandidatePairEntry[]): number | null {
  let nominatedRtt: number | null = null;
  let anyRtt: number | null = null;
  for (const pair of pairs) {
    if (pair.type !== "candidate-pair" || pair.state !== "succeeded") {
      continue;
    }
    const seconds = pair.currentRoundTripTime;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      continue;
    }
    const millis = Math.round(seconds * 1000);
    if (nominatedRtt === null && pair.nominated === true) {
      nominatedRtt = millis;
    }
    if (anyRtt === null) {
      anyRtt = millis;
    }
  }
  return nominatedRtt ?? anyRtt;
}

/** Signal-quality tiers for the voice waves glyph (Discord-style): 3 waves =
 *  good, 2 = tolerable, 1 = poor, 0 = no reading yet (all waves dim — the
 *  transport is up but no pair has reported a round trip). Round-trip
 *  thresholds: a 120 ms RTT is ~60 ms one-way (unnoticeable), 250 ms one-way
 *  ~125 ms starts to read as walkie-talkie. */
export type VoiceSignalLevel = 0 | 1 | 2 | 3;

export const VOICE_SIGNAL_GOOD_RTT_MS = 120;
export const VOICE_SIGNAL_WEAK_RTT_MS = 250;

export function voiceSignalLevel(rttMillis: number | null): VoiceSignalLevel {
  if (rttMillis === null || !Number.isFinite(rttMillis) || rttMillis < 0) {
    return 0;
  }
  if (rttMillis < VOICE_SIGNAL_GOOD_RTT_MS) {
    return 3;
  }
  return rttMillis < VOICE_SIGNAL_WEAK_RTT_MS ? 2 : 1;
}
