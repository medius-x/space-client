import { describe, expect, it } from "vitest";
import {
  computeMosaicTiles,
  gridTileSide,
  isAudioFile,
  isImageFile,
  isVideoFile,
  MAX_IMAGE_TILE_SIDE,
  mosaicColumns,
  mosaicHeight,
  reservedVideoThumbBox,
  singleTileBox,
  splitFileNameExt,
  VIDEO_CARD_CHROME,
} from "../src/domain/logic/attachment-layout";

// The math mirrors oak's AttachmentLayoutTest (TILE_GAP = 4, square mosaic
// tiles); the single image is a no-upscale aspect fit, not oak's square.

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
  it("subtracts only the BETWEEN-column gaps (oak's pinned 164/248)", () => {
    expect(gridTileSide(500, 3)).toBe(164); // (500 - 4*2) / 3
    expect(gridTileSide(500, 2)).toBe(248); // (500 - 4) / 2
  });

  it("the side is capped — stretching the window never grows tiles past 320", () => {
    expect(gridTileSide(500, 1)).toBe(320); // a lone column would be the full row
    expect(gridTileSide(1600, 2)).toBe(320);
    expect(gridTileSide(200, 2)).toBe(98); // narrow rows stay narrow — the cap never upscales
  });
});

describe("singleTileBox", () => {
  it("a no-upscale fit into the 320 ceiling — never bounded by the SMALLER side", () => {
    // An 800×150 strip used to render 150×28 (the old smaller-side rule):
    // each side is capped by its OWN natural side, so the strip reaches 320 wide.
    expect(singleTileBox(918, 800, 150)).toEqual({ width: 320, height: 60 });
    expect(singleTileBox(918, 1920, 1080)).toEqual({ width: 320, height: 180 }); // landscape at the cap
    expect(singleTileBox(918, 400, 900)).toEqual({ width: 142, height: 320 }); // portrait: height = the cap
  });

  it("no upscale: a small image stays its own size", () => {
    expect(singleTileBox(918, 64, 64)).toEqual({ width: 64, height: 64 });
    expect(singleTileBox(918, 240, 150)).toEqual({ width: 240, height: 150 });
  });

  it("a huge image is capped, not row-wide — the window can no longer grow it", () => {
    expect(singleTileBox(918, 4000, 3000)).toEqual({ width: 320, height: 240 });
    expect(singleTileBox(1600, 4000, 3000)).toEqual({ width: 320, height: 240 });
  });

  it("unknown natural size → the square placeholder (capped)", () => {
    expect(singleTileBox(600, 0, 0)).toEqual({ width: 320, height: 320 });
    expect(singleTileBox(240, 0, 0)).toEqual({ width: 240, height: 240 });
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

describe("reservedVideoThumbBox", () => {
  it("a 1080p landscape preview caps at the tile cap MINUS the card chrome — the card aligns with the 320 image tiles", () => {
    expect(reservedVideoThumbBox(1920, 1080, MAX_IMAGE_TILE_SIDE - VIDEO_CARD_CHROME, 320)).toEqual({ width: 306, height: 172 });
  });

  it("a portrait preview keeps the height cap and its own aspect", () => {
    expect(reservedVideoThumbBox(1080, 1920, MAX_IMAGE_TILE_SIDE - VIDEO_CARD_CHROME, 320)).toEqual({ width: 180, height: 320 });
  });

  it("the box is width-row-INDEPENDENT — narrowing the window never shrinks the preview (user decision)", () => {
    // The maxWidth ceiling is the tile cap (minus chrome), not the row: the
    // same box whatever the caller's row width is — the card may overflow a
    // narrow row instead.
    expect(reservedVideoThumbBox(2560, 1440, MAX_IMAGE_TILE_SIDE - VIDEO_CARD_CHROME, 320)).toEqual({ width: 306, height: 172 });
  });

  it("unknown dimensions fall back to the 16:9 plate", () => {
    expect(reservedVideoThumbBox(0, 0, 306, 320)).toEqual({ width: 306, height: 172 });
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

describe("splitFileNameExt", () => {
  it("the LAST dot splits base from a dotted extension", () => {
    expect(splitFileNameExt("clip.mp4")).toEqual({ base: "clip", ext: ".mp4" });
    expect(splitFileNameExt("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
  });

  it("no extension or a LEADING dot keeps everything in the base", () => {
    expect(splitFileNameExt("noext")).toEqual({ base: "noext", ext: "" });
    expect(splitFileNameExt(".hidden")).toEqual({ base: ".hidden", ext: "" });
  });
});
