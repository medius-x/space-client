/**
 * The body font's average glyph width, MEASURED on this machine (canvas
 * measureText of the actual 13px Open Sans) instead of the hardcoded ~7px —
 * the wrap estimate (chars-per-line) divides by it, and a systematic glyph
 * error means every text row's first measurement drifts the same way, which
 * the virtualizer's first-measure compensation turns into thumb jerks while
 * scrolling up (the "scrollbar bounces through heavy history" report's second
 * pass, 2026-10-19: image math was already exact; text was the remaining
 * guess). Re-measured once the webfont settles — document.fonts.ready — so a
 * fallback-font measurement never sticks.
 */

/** The historical assumption — the floor/fallback of the measurement. */
const FALLBACK_GLYPH_PX = 7;

const SAMPLE =
  "The quick brown fox jumps over the lazy dog 0123456789 Съешь ещё этих мягких французских булок, да выпей чаю";

let cachedGlyphPx = FALLBACK_GLYPH_PX;
let armed = false;

function measure(): void {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.font = "13px 'Open Sans', sans-serif";
    const width = context.measureText(SAMPLE).width / SAMPLE.length;
    if (Number.isFinite(width) && width > 3 && width < 20) {
      cachedGlyphPx = width;
    }
  } catch {
    // no 2d canvas — the fallback stands
  }
}

/** The average glyph width of the chat body font, in CSS pixels. */
export function bodyGlyphWidthPx(): number {
  if (!armed && typeof document !== "undefined") {
    armed = true;
    measure();
    void document.fonts?.ready.then(() => {
      measure(); // the webfont may have settled after the first call
    }).catch(() => undefined);
  }
  return cachedGlyphPx;
}
