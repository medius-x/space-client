/**
 * oak's image mosaic (AttachmentLayout.java), pure math, unit-tested:
 * 1 image renders as an aspect-hugging box, no-upscale-fitted into the
 * MAX_IMAGE_TILE_SIDE ceiling on each axis and the row width — NEVER
 * upscaled past its natural size (64×64 stays 64×64); 2–3 images render in
 * ONE row of square, center-cropped tiles; 4–10
 * render in a 2-column grid of square, center-cropped tiles (a crop — not a
 * fit — is what keeps the grid compact; the Discord way). The caller caps the
 * count at MAX_ATTACHMENTS (the server's limit).
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

/** The square side of a grid/row tile: the gap is only BETWEEN columns. */
export function gridTileSide(usableWidth: number, columns: number): number {
  return Math.min(MAX_IMAGE_TILE_SIDE, Math.floor((usableWidth - TILE_GAP * (columns - 1)) / columns));
}

/** The single image's actual BOX (user decision, 2026-09-15: the box HUGS the
 *  image's aspect ratio — oak keeps the square bounding box, and the black
 *  padding read as broken rendering): a true no-upscale fit into the tile-side
 *  ceiling on EACH axis and the row width — each side of the box never exceeds
 *  the image's own side (64×64 stays 64×64). The old oak-ported rule bounded
 *  the box by the image's SMALLER side, which crushed elongated pictures (an
 *  800×150 strip rendered 150×28 — "tiny in chat, large in the lightbox",
 *  live report 2026-11-17); with an aspect-hugging box the bound belongs on
 *  each side separately. */
export function singleTileBox(usableWidth: number, naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    const side = Math.min(usableWidth, MAX_IMAGE_TILE_SIDE); // unknown yet — the square placeholder
    return { width: side, height: side };
  }
  const scale = Math.min(
    MAX_IMAGE_TILE_SIDE / naturalWidth,
    MAX_IMAGE_TILE_SIDE / naturalHeight,
    usableWidth / naturalWidth,
    1, // never upscale
  );
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/** The 2+ tiles — all square, all the same side. The single image is NOT here:
 *  it is sized by singleTileBox against its own natural dimensions. */
export function computeMosaicTiles(count: number, containerWidth: number): MosaicTile[] {
  const usable = Math.max(120, Math.floor(containerWidth));
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
 *  preview at its own aspect, capped by the IMAGE-TILE side ceiling on BOTH
 *  axes — the caller passes MAX_IMAGE_TILE_SIDE, NOT the row width (user
 *  decision 2026-11-17: the preview and its card stay put when the window
 *  narrows; a too-narrow row lets the card overflow rather than shrink the
 *  frame). This is the same fit computed BEFORE the bytes arrive, from
 *  the wire's intrinsic dimensions (or a learned-cache aspect) — the row then
 *  reserves the exact height and the decode never shifts the layout. Zero/absent
 *  dimensions fall back to the historical 16:9 plate (320×180). */
export function reservedVideoThumbBox(naturalWidth: number, naturalHeight: number, maxWidth: number, maxHeight: number):
  { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    const side = Math.min(320, Math.max(120, maxWidth));
    return { width: side, height: Math.round(side * 9 / 16) };
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}
