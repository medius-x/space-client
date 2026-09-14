import { describe, expect, it } from "vitest";
import {
  computeMosaicTiles,
  gridTileSide,
  isAudioFile,
  isImageFile,
  isVideoFile,
  mosaicColumns,
  mosaicHeight,
  singleTileBox,
  singleTileSide,
} from "../src/domain/logic/attachment-layout";

// The math mirrors oak's AttachmentLayoutTest (TILE_GAP = 4, square tiles,
// the single image bounded by its own smaller natural side).

describe("mosaicColumns", () => {
  it("1 → 1, 2–3 → count, 4+ → 2", () => {
    expect(mosaicColumns(1)).toBe(1);
    expect(mosaicColumns(2)).toBe(2);
    expect(mosaicColumns(3)).toBe(3);
    expect(mosaicColumns(4)).toBe(2);
    expect(mosaicColumns(10)).toBe(2);
  });
});

describe("gridTileSide", () => {
  it("subtracts only the BETWEEN-column gaps (oak's pinned 164/248/500)", () => {
    expect(gridTileSide(500, 3)).toBe(164); // (500 - 4*2) / 3
    expect(gridTileSide(500, 2)).toBe(248); // (500 - 4) / 2
    expect(gridTileSide(500, 1)).toBe(500); // no gap for a lone column
  });
});

describe("singleTileSide", () => {
  it("is bounded by the image's OWN smaller natural side — never upscaled (oak)", () => {
    expect(singleTileSide(918, 64, 64)).toBe(64);
    expect(singleTileSide(918, 4000, 3000)).toBe(918); // landscape larger than the row
    expect(singleTileSide(918, 400, 300)).toBe(300);
    expect(singleTileSide(918, 240, 900)).toBe(240); // portrait: the width wins
  });

  it("unknown natural size → the full usable width (the decode replaces it)", () => {
    expect(singleTileSide(600, 0, 0)).toBe(600);
    expect(singleTileSide(600, -1, -1)).toBe(600);
  });
});

describe("singleTileBox", () => {
  it("the fitted image with the letterbox trimmed — never a padded square (user decision)", () => {
    expect(singleTileBox(918, 1920, 1080)).toEqual({ width: 918, height: 516 }); // landscape: fills the row width
    expect(singleTileBox(918, 400, 900)).toEqual({ width: 178, height: 400 }); // portrait: height = the square side
  });

  it("no upscale: a small image stays its own size", () => {
    expect(singleTileBox(918, 64, 64)).toEqual({ width: 64, height: 64 });
    expect(singleTileBox(918, 240, 900)).toEqual({ width: 64, height: 240 });
  });

  it("unknown natural size → the square placeholder", () => {
    expect(singleTileBox(600, 0, 0)).toEqual({ width: 600, height: 600 });
  });
});

describe("computeMosaicTiles", () => {
  it("the single image is NOT in the tiles — it is sized by singleTileSide", () => {
    expect(computeMosaicTiles(1, 600)).toEqual([]);
    expect(computeMosaicTiles(0, 600)).toEqual([]);
  });

  it("2–3 images: one row of squares with the 4px gap between columns", () => {
    const two = computeMosaicTiles(2, 416);
    expect(two).toHaveLength(2);
    expect(two[0]?.width).toBe(206); // (416 - 4) / 2
    expect(two[0]?.height).toBe(206);
    const three = computeMosaicTiles(3, 416);
    expect(three).toHaveLength(3);
    expect(three[0]?.width).toBe(136); // (416 - 8) / 3
  });

  it("4+: a 2-column grid of squares", () => {
    const tiles = computeMosaicTiles(6, 408);
    expect(tiles).toHaveLength(6);
    expect(tiles[0]?.width).toBe(202);
    expect(tiles[0]?.height).toBe(202);
  });

  it("tiny containers degrade safely", () => {
    const tiles = computeMosaicTiles(3, 10);
    expect(tiles[0]?.width).toBeGreaterThan(0);
  });

  it("mosaicHeight: row vs grid with the 4px gaps", () => {
    expect(mosaicHeight(computeMosaicTiles(3, 416))).toBe(136);
    expect(mosaicHeight(computeMosaicTiles(6, 408))).toBe(3 * 202 + 2 * 4); // 3 rows + gaps
    expect(mosaicHeight([])).toBe(0);
  });
});

describe("file-type sniffing by extension", () => {
  it("images / audio / video sets, case-insensitive, unknown → all false", () => {
    expect(isImageFile("photo.JPG")).toBe(true);
    expect(isImageFile("avatar.webp")).toBe(true);
    expect(isVideoFile("clip.MP4")).toBe(true);
    expect(isVideoFile("movie.mkv")).toBe(true);
    expect(isAudioFile("song.mp3")).toBe(true);
    expect(isAudioFile("voice.opus")).toBe(true);
    expect(isImageFile("archive.zip")).toBe(false);
    expect(isVideoFile("noext")).toBe(false);
  });
});
