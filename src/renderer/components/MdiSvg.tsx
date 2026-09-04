/**
 * Inline SVG glyphs for MDI icons the bundled webfont (1.7.22) lacks — the same
 * path data oak's Icons.java embeds (from @mdi/svg 5.2.45/7.4.47). The webfont
 * covers everything else (see styles/icons.css).
 */
export const HEADPHONES_OFF_PATH =
  "M12,1A9,9 0 0,1 21,10V17C21,17.62 20.81,18.19 20.5,18.67L15,13.18V12H19V10A7,7 0 0,0 12,3C10,3 8.23,3.82 6.96,5.14L5.55,3.72C7.18,2.04 9.47,1 12,1M2.78,3.5L20.5,21.22L19.23,22.5L16.73,20H15V18.27L9,12.27V20H6A3,3 0 0,1 3,17V10C3,8.89 3.2,7.82 3.57,6.84L1.5,4.77L2.78,3.5M5.17,8.44C5.06,8.94 5,9.46 5,10V12H8.73L5.17,8.44Z";

export const TRIANGLE_WAVE_PATH =
  "M22 12L17 22L7.1 6.04L4.24 12H2L7 2L16.9 17.96L19.76 12H22Z";

/** The noise-suppression glyph (the NS toggle). */
export function TriangleWaveIcon({ size, color = "currentColor" }: { size: number; color?: string }): React.JSX.Element {
  return <MdiSvg path={TRIANGLE_WAVE_PATH} size={size} color={color} />;
}

/** Crossed-out headphones — the deafen counterpart to mdi-microphone-off. */
export function HeadphonesOffIcon({ size, color = "currentColor" }: { size: number; color?: string }): React.JSX.Element {
  return <MdiSvg path={HEADPHONES_OFF_PATH} size={size} color={color} />;
}

function MdiSvg({ path, size, color }: { path: string; size: number; color: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color} style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
