/**
 * Discord-style mosaic for message images — pure math, unit-tested. 1 image:
 * one large tile; 2–3: a row; 4+: a 2-column grid of squares. The caller caps
 * the count at 10 (the server's MAX_ATTACHMENTS).
 */

export interface MosaicTile {
  width: number;
  height: number;
}

const GAP = 8;
const SINGLE_MAX_WIDTH = 420;
const SINGLE_HEIGHT = 280;
const ROW_HEIGHT = 200;

export function computeMosaicTiles(count: number, containerWidth: number): MosaicTile[] {
  const usable = Math.max(120, Math.floor(containerWidth));
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [{ width: Math.min(usable, SINGLE_MAX_WIDTH), height: SINGLE_HEIGHT }];
  }
  if (count <= 3) {
    const width = Math.floor((usable - GAP * (count - 1)) / count);
    return Array.from({ length: count }, () => ({ width, height: ROW_HEIGHT }));
  }
  const width = Math.floor((usable - GAP) / 2);
  return Array.from({ length: count }, () => ({ width, height: width }));
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
  return rows * rowHeight + (rows - 1) * GAP;
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
