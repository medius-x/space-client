/**
 * Pure audio math — unit-tested; RoomAudio is thin DOM glue over these.
 */

/** RMS (linear, 0..1) → dBFS. −∞ is clamped to −100 for display/storage. */
export function rmsToDbfs(rms: number): number {
  if (rms <= 0) {
    return -100;
  }
  return Math.max(-100, 20 * Math.log10(rms));
}

/** Root-mean-square of float samples in [−1, 1]. */
export function floatRms(samples: Float32Array): number {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index++) {
    sumSquares += samples[index]! * samples[index]!;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
}

/** Java-client calibration translated to float domain (noise floor 50/32768, full 1100/32768). */
export const SPEAKING_NOISE_FLOOR = 50 / 32768;
export const SPEAKING_FULL_SCALE = 1100 / 32768;
const SPEAKING_DECAY = 0.03;

/**
 * Short-domain level 0..1 with instant attack / exponential decay — same shape as the
 * Java mic level. Gates near-silence to 0 so background hum never shows as speaking.
 */
export function speakingLevel(instantRms: number, previousLevel: number): number {
  const instant = instantRms < SPEAKING_NOISE_FLOOR
    ? 0
    : Math.min(1, (instantRms - SPEAKING_NOISE_FLOOR) / SPEAKING_FULL_SCALE);
  return instant > previousLevel ? instant : previousLevel + (instant - previousLevel) * SPEAKING_DECAY;
}

/** Ring above which a feed counts as SPEAKING (hysteresis-free — decay handles chatter). */
export function isSpeaking(level: number): boolean {
  return level > 0.08;
}

export interface StereoVerdictInput {
  leftDbfs: number;
  rightDbfs: number;
}

export type StereoVerdict = "PASS" | "MONO" | "SILENT";

/**
 * The acoustic oracle verdict: with a hard-panned test tone playing, Δ = |L − R| above
 * 10 dB for the sustained window means real stereo; under 3 dB with signal present means
 * downmix; both channels under −70 dBFS means no audio path at all.
 */
export function stereoVerdict(reading: StereoVerdictInput): StereoVerdict {
  const delta = Math.abs(reading.leftDbfs - reading.rightDbfs);
  const loudest = Math.max(reading.leftDbfs, reading.rightDbfs);
  if (loudest < -70) {
    return "SILENT";
  }
  if (delta >= 10) {
    return "PASS";
  }
  if (delta < 3) {
    return "MONO";
  }
  return "MONO"; // 3..10 dB — ambiguous band; report mono (do not overclaim)
}
