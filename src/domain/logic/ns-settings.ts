/**
 * The DeepFilterNet3 suppression-limit knob (user report 2026-11-04: "the
 * slider seems to do nothing"). The native `df_set_atten_lim` takes a
 * PER-FRAME attenuation ceiling in dB — 0 disables the limiter entirely (the
 * model's full strength). The old 0..100 UI parked the default at 50 dB
 * (effectively unlimited: speech frames never attenuate that deep), so most
 * of the range was inaudible and the artifacts the report described (eaten
 * phrase onsets, post-silence ducking) lived BELOW the ceiling untouched.
 * The usable voice band is narrow — 6..40 dB — and that is the whole slider now.
 */
export const DEEP_FILTER_ATTEN_MIN_DB = 6;
export const DEEP_FILTER_ATTEN_MAX_DB = 40;
export const DEEP_FILTER_ATTEN_DEFAULT_DB = 15;

/**
 * Hand-edited KV / legacy values → the band. The legacy semantics are
 * preserved by intent: 0 meant "no limiter = the STRONGEST suppression" (the
 * old default of 50 was nearly the same), so it remaps to the new maximum;
 * the old ultra-gentle 1..5 dB caps clamp up to the band floor; garbage
 * (non-number, NaN) restores the default.
 */
export function sanitizeDeepFilterSuppressionLevel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEEP_FILTER_ATTEN_DEFAULT_DB;
  }
  if (value === 0) {
    return DEEP_FILTER_ATTEN_MAX_DB; // legacy "no limiter" = strongest
  }
  if (value < DEEP_FILTER_ATTEN_MIN_DB) {
    return DEEP_FILTER_ATTEN_MIN_DB; // legacy ultra-gentle 1..5 dB caps
  }
  return Math.min(DEEP_FILTER_ATTEN_MAX_DB, Math.round(value));
}
