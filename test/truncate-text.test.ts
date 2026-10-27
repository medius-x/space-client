import { describe, expect, it } from "vitest";
import { truncateTextToWidth } from "../src/renderer/glyph-metrics";

/** A deterministic stand-in for canvas measureText: every character costs the
 *  same fixed width (the ellipsis included — it is a character too). */
const fixedGlyphMeasure = (glyphPx: number): ((text: string) => number) =>
  (text) => text.length * glyphPx;

describe("truncateTextToWidth", () => {
  it("returns the text as-is when it already fits", () => {
    expect(truncateTextToWidth("abc", 100, fixedGlyphMeasure(7))).toBe("abc");
  });

  it("returns empty text unchanged", () => {
    expect(truncateTextToWidth("", 10, fixedGlyphMeasure(7))).toBe("");
  });

  it("clips to the longest prefix that fits WITH the ellipsis", () => {
    // 10 chars at 7px = 70px; budget 35px fits 5 glyphs, one of which is "…"
    expect(truncateTextToWidth("abcdefghij", 35, fixedGlyphMeasure(7))).toBe("abcd…");
    // 42px fits 6 glyphs → 5 characters + "…"
    expect(truncateTextToWidth("abcdefghij", 42, fixedGlyphMeasure(7))).toBe("abcde…");
  });

  it("returns a lone ellipsis when not even one character fits", () => {
    expect(truncateTextToWidth("abcdefghij", 3, fixedGlyphMeasure(7))).toBe("…");
  });

  it("keeps every result within the budget across a width ladder", () => {
    const measure = fixedGlyphMeasure(3);
    const text = "Соilgggiл длинный канал placeholder";
    for (let maxWidth = measure("…"); maxWidth <= measure(text); maxWidth += 1) {
      const clipped = truncateTextToWidth(text, maxWidth, measure);
      expect(measure(clipped)).toBeLessThanOrEqual(maxWidth);
      if (clipped !== text) {
        expect(clipped.endsWith("…")).toBe(true);
      }
    }
  });

  it("prefers the longest possible prefix (binary-search off-by-one guard)", () => {
    const measure = fixedGlyphMeasure(5);
    // Budget 40 = 8 glyphs → 7 chars + "…" must fit, 8 chars + "…" must not.
    const clipped = truncateTextToWidth("0123456789", 40, measure);
    expect(clipped).toBe("0123456…");
    expect(measure(clipped + "X".repeat(1))).toBeGreaterThan(40);
  });
});
