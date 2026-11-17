/**
 * oak's image mosaic (AttachmentLayout.java), pure math, unit-tested:
 * 1 image renders as an aspect-hugging box, no-upscale-fitted into the LIVE
 * single-media cap (peaks at SINGLE_MEDIA_MAX_SIDE, follows the row width
 * down to MIN_TILE_SIDE); 2–3 images render in ONE row of square,
 * center-cropped tiles; 4–10 render in a 2-column grid of square,
 * center-cropped tiles (a crop — not a fit — is what keeps the grid compact;
 * the Discord way). The caller caps the count at MAX_ATTACHMENTS (the
 * server's limit).
 */

export interface MosaicTile {
  width: number;
  height: number;
}

export const MAX_ATTACHMENTS = 10;
/** oak's TILE_GAP = 4 (we had 8 — this is a straight port). */
export const TILE_GAP = 4;
/** The ceiling for EVERY image tile side (single AND mosaic), the video thumb's
 *  max-height precedent. Without it a large image scales with the chat pane's
 *  width — the row usable width was the ONLY cap, so stretching the window
 *  grew the picture without bound (live report 2026-10-19). The lightbox
 *  remains the full-size view. */
export const MAX_IMAGE_TILE_SIDE = 320;

/** The floor for EVERY media tile side — single pictures, video previews and
 *  mosaic tiles alike (user decision 2026-11-17: one shared "smallest
 *  sensible element" instead of per-kind bottoms). Below it a media block
 *  OVERFLOWS its row rather than shrinking further: the video's fixed 48px
 *  play circle and duration badge stop making sense inside a smaller frame. */
export const MIN_TILE_SIDE = 120;

/** The single picture/video's PEAK: 1.5× the mosaic tile cap (user decision
 *  2026-11-17) — a lone image deserves more room than a mosaic tile, and the
 *  video card's outer edge matches this at its peak so singles and videos
 *  sit flush in neighbouring messages. Mosaic tiles stay at the 320 cap. */
export const SINGLE_MEDIA_MAX_SIDE = MAX_IMAGE_TILE_SIDE * 3 / 2;

/** The single media's LIVE size ceiling: the row width clamped into
 *  [MIN_TILE_SIDE, SINGLE_MEDIA_MAX_SIDE]. A wide row → the peak; a narrowing
 *  row → the ceiling follows it down (the media resizes with the window);
 *  a row past the floor → the floor (overflow beats a broken frame). */
export function singleMediaCapSide(usableWidth: number): number {
  return Math.max(MIN_TILE_SIDE, Math.min(SINGLE_MEDIA_MAX_SIDE, usableWidth));
}

/** The video card's horizontal chrome (.video-card: 6+6 padding, 1+1 border).
 *  The preview's WIDTH cap subtracts it, so the card's outer width
 *  (preview + chrome) aligns exactly with the 320px image tiles rendered
 *  beside it in neighbouring messages (live report 2026-11-17: the video
 *  card's edge stuck 14px past the pictures). */
export const VIDEO_CARD_CHROME = 14;

/** oak's columnsFor: 1 → 1, 2–3 → count, 4+ → 2. */
export function mosaicColumns(count: number): number {
  if (count <= 1) {
    return 1;
  }
  if (count <= 3) {
    return count;
  }
  return 2;
}

/** The square side of a grid/row tile: the gap is only BETWEEN columns. The
 *  floor is the shared MIN_TILE_SIDE — below it the row overflows instead of
 *  crumbling into unreadable squares (user decision 2026-11-17). */
export function gridTileSide(usableWidth: number, columns: number): number {
  const side = Math.min(MAX_IMAGE_TILE_SIDE, Math.floor((usableWidth - TILE_GAP * (columns - 1)) / columns));
  return Math.max(MIN_TILE_SIDE, side);
}

/** The single image's actual BOX (user decision, 2026-09-15: the box HUGS the
 *  image's aspect ratio — oak keeps the square bounding box, and the black
 *  padding read as broken rendering): a true no-upscale fit into the LIVE
 *  single-media ceiling (singleMediaCapSide of the row width) on EACH axis —
 *  each side of the box never exceeds the image's own side (64×64 stays
 *  64×64). The old oak-ported rule bounded the box by the image's SMALLER
 *  side, which crushed elongated pictures (an 800×150 strip rendered 150×28
 *  — "tiny in chat, large in the lightbox", live report 2026-11-17); with an
 *  aspect-hugging box the bound belongs on each side separately. Since
 *  2026-11-17 the ceiling RIDES THE WINDOW: the picture peaks at
 *  SINGLE_MEDIA_MAX_SIDE and shrinks as the row narrows, down to the shared
 *  MIN_TILE_SIDE floor (narrower rows overflow instead of shrinking further). */
export function singleTileBox(usableWidth: number, naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    const side = singleMediaCapSide(usableWidth); // unknown yet — the square placeholder
    return { width: side, height: side };
  }
  const capSide = singleMediaCapSide(usableWidth);
  const scale = Math.min(
    capSide / naturalWidth,
    capSide / naturalHeight,
    1, // never upscale
  );
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/** The 2+ tiles — all square, all the same side (floored at MIN_TILE_SIDE).
 *  The single image is NOT here: it is sized by singleTileBox against its own
 *  natural dimensions. */
export function computeMosaicTiles(count: number, containerWidth: number): MosaicTile[] {
  const usable = Math.max(MIN_TILE_SIDE, Math.floor(containerWidth));
  if (count <= 1) {
    return [];
  }
  const side = gridTileSide(usable, mosaicColumns(count));
  return Array.from({ length: count }, () => ({ width: side, height: side }));
}

export function mosaicHeight(tiles: readonly MosaicTile[]): number {
  if (tiles.length === 0) {
    return 0;
  }
  if (tiles.length <= 3) {
    return tiles[0]?.height ?? 0;
  }
  const rows = Math.ceil(tiles.length / 2);
  const rowHeight = tiles[0]?.height ?? 0;
  return rows * rowHeight + (rows - 1) * TILE_GAP;
}

/** File-type sniffing by extension (the DTO carries no content type). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "opus", "flac", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

export function isImageFile(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(fileName));
}

export function isAudioFile(fileName: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(fileName));
}

export function isVideoFile(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(fileName));
}

/** Splits a file name for the video card's name row: the BASE ellipsizes,
 *  the extension (with its dot) stays pinned at the end — "long_na….mp4"
 *  (user request 2026-11-17: the card must never grow wider than its
 *  preview, yet the extension stays readable). A leading-dot name
 *  (".hidden") has no extension part. */
export function splitFileNameExt(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return { base: fileName, ext: "" };
  }
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

/** The video card's thumb box (2026-09-25, the exact-reservation round): the
 *  preview at its own aspect, capped by the LIVE single-media ceiling
 *  (user decision 2026-11-17, same evening: the earlier same-day "never
 *  shrink with the window" rule was replaced — singles and videos now resize
 *  WITH the window together): the width cap is singleMediaCapSide(row width)
 *  minus VIDEO_CARD_CHROME (so the card's OUTER edge sits flush with the
 *  single picture at the same row width), the height cap the ceiling itself;
 *  neither drops below the shared MIN_TILE_SIDE (past it the card overflows
 *  rather than cramp its fixed 48px play circle and name row). This is the
 *  same fit computed BEFORE the bytes arrive, from the wire's intrinsic
 *  dimensions (or a learned-cache aspect) — the row then reserves the exact
 *  height and the decode never shifts the layout. Zero/absent dimensions
 *  fall back to the historical 16:9 plate. */
export function reservedVideoThumbBox(usableWidth: number, naturalWidth: number, naturalHeight: number):
  { width: number; height: number } {
  const capSide = singleMediaCapSide(usableWidth);
  const maxWidth = Math.max(MIN_TILE_SIDE, capSide - VIDEO_CARD_CHROME);
  const maxHeight = capSide;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: maxWidth, height: Math.round(maxWidth * 9 / 16) };
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}
