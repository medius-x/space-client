/**
 * Google Material Symbols — OUTLINED, the user's hand-picked glyphs
 * (fonts.google.com/icons, 2026-11-19; MDI equivalents were rejected as
 * artwork). Vendored as SVG path data, NOT as a second icon font: a handful
 * of glyphs does not justify a ~300 KB variable woff2 beside the MDI font,
 * and the paths below are the site's exact artwork (Apache 2.0,
 * github.com/google/material-design-icons, symbols/web/&lt;name&gt;/…outlined_24px).
 * The grid is `0 -960 960 960`; ink is `currentColor`, size rides the em box
 * (1em × 1em) so a `font-size`-sized context (the `.icon` idiom) sizes these
 * exactly like the font glyphs.
 */
const GLYPH_PATHS = {
  "sports_esports":
    "M182-200q-51 0-79-35.5T82-322l42-300q9-60 53.5-99T282-760h396q60 0 104.5 39t53.5 99l42 300q7 51-21 86.5T778-200q-21 0-39-7.5T706-230l-90-90H344l-90 90q-15 15-33 22.5t-39 7.5Zm16-86 114-114h336l114 114q2 2 16 6 11 0 17.5-6.5T800-304l-44-308q-4-29-26-48.5T678-680H282q-30 0-52 19.5T204-612l-44 308q-2 11 4.5 17.5T182-280q2 0 16-6Zm482-154q17 0 28.5-11.5T720-480q0-17-11.5-28.5T680-520q-17 0-28.5 11.5T640-480q0 17 11.5 28.5T680-440Zm-80-120q17 0 28.5-11.5T640-600q0-17-11.5-28.5T600-640q-17 0-28.5 11.5T560-600q0 17 11.5 28.5T600-560ZM310-440h60v-70h70v-60h-70v-70h-60v70h-70v60h70v70Zm170-40Z",
  "headphones":
    "M360-120H200q-33 0-56.5-23.5T120-200v-280q0-75 28.5-140.5t77-114q48.5-48.5 114-77T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480v280q0 33-23.5 56.5T760-120H600v-320h160v-40q0-117-81.5-198.5T480-760q-117 0-198.5 81.5T200-480v40h160v320Zm-80-240h-80v160h80v-160Zm400 0v160h80v-160h-80Zm-400 0h-80 80Zm400 0h80-80Z",
  "desktop_windows":
    "M320-120v-80h80v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H560v80h80v80H320ZM160-360h640v-400H160v400Zm0 0v-400 400Z",
  "live_tv":
    "m380-340 280-180-280-180v360Zm-60 220v-80H160q-33 0-56.5-23.5T80-280v-480q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v480q0 33-23.5 56.5T800-200H640v80H320ZM160-280h640v-480H160v480Zm0 0v-480 480Z",
  "trophy":
    "M280-120v-80h160v-124q-49-11-87.5-41.5T296-442q-75-9-125.5-65.5T120-640v-40q0-33 23.5-56.5T200-760h80v-80h400v80h80q33 0 56.5 23.5T840-680v40q0 76-50.5 132.5T664-442q-18 46-56.5 76.5T520-324v124h160v80H280Zm0-408v-152h-80v40q0 38 22 68.5t58 43.5Zm200 128q50 0 85-35t35-85v-240H360v240q0 50 35 85t85 35Zm200-128q36-13 58-43.5t22-68.5v-40h-80v152Zm-200-52Z",
} as const;

export type MaterialGlyphName = keyof typeof GLYPH_PATHS;

/** One Material Symbols glyph: inline SVG, `currentColor` ink, 1em × 1em —
 *  pass the MDI `icon` class alongside when it replaces a font glyph in a
 *  `font-size`-sized context. */
export function MaterialGlyph({ name, className }: { name: MaterialGlyphName; className?: string }) {
  return (
    <svg
      className={"material-glyph" + (className === undefined ? "" : ` ${className}`)}
      viewBox="0 -960 960 960"
      aria-hidden="true"
      focusable="false"
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}
