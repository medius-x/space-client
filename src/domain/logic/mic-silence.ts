/**
 * The mid-session dead-mic detector (live report 2026-10-30: a wireless headset
 * dongle stopped delivering audio mid-call while staying present in the system —
 * Chromium kept the capture open and published perfect digital silence; no track
 * event, no error, the only trace was the self speaking ring never lighting).
 *
 * The detector watches the RAW capture's RMS: a real analog input always carries
 * a noise floor above the threshold, while a dead WASAPI stream (or a hardware
 * headset mute) is an exact zero. The streak must persist for the full threshold
 * before the verdict — brief pauses never qualify. Time comes in explicitly so
 * the pure core stays testable without timers.
 */

export const MIC_SILENCE_THRESHOLD_MS = 90_000;

/** RMS at or below this counts as digital silence (a live input's noise floor stays well above). */
export const DIGITAL_ZERO_RMS = 1e-6;

export interface MicSilenceTracker {
  /** Feed one analysis frame; returns the current silent verdict. */
  feed(rms: number, nowMillis: number): boolean;
  /** Drop the streak (a deliberate mute also produces silence — it must not accumulate). */
  reset(): void;
  isSilent(): boolean;
}

export function createMicSilenceTracker(thresholdMillis: number = MIC_SILENCE_THRESHOLD_MS): MicSilenceTracker {
  let silentSince: number | null = null;
  let silent = false;

  return {
    feed(rms: number, nowMillis: number): boolean {
      if (!(rms > DIGITAL_ZERO_RMS)) {
        // NaN also lands here (fail-safe: an unreadable level never proves life).
        if (silentSince === null) {
          silentSince = nowMillis;
        }
        silent = nowMillis - silentSince >= thresholdMillis;
        return silent;
      }
      silentSince = null;
      silent = false;
      return false;
    },
    reset(): void {
      silentSince = null;
      silent = false;
    },
    isSilent(): boolean {
      return silent;
    },
  };
}
