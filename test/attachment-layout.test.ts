import { describe, expect, it } from "vitest";
import {
  computeMosaicTiles,
  gridTileSide,
  isAudioFile,
  isImageFile,
  isVideoFile,
  MIN_TILE_SIDE,
  mosaicColumns,
  mosaicHeight,
  reservedVideoThumbBox,
  singleTileBox,
  splitFileNameExt,
  VIDEO_CARD_CHROME,
} from "../src/domain/logic/attachment-layout";

// The math mirrors oak's AttachmentLayoutTest (TILE_GAP = 4, square mosaic
// tiles); the single image is a no-upscale aspect fit, not oak's square.
// Since 2026-11-17 the single picture and the video card ride the window:
// peak 1.5× the mosaic tile cap, floor MIN_TILE_SIDE (120) everywhere.

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
    expect(gridTileSide(260, 2)).toBe(128); // above the floor — plain division
  });

  it("the side is floored at MIN_TILE_SIDE — a row past it overflows, never crumbles", () => {
    expect(gridTileSide(200, 2)).toBe(MIN_TILE_SIDE); // plain math 98 → the floor
    expect(gridTileSide(300, 3)).toBe(MIN_TILE_SIDE); // plain math 97 → the floor
  });
});

describe("singleTileBox", () => {
  it("a no-upscale fit into the 480 single-media peak — never bounded by the SMALLER side", () => {
    // An 800×150 strip used to render 150×28 (the old smaller-side rule):
    // each side is capped by its OWN natural side, so the strip reaches 480 wide.
    expect(singleTileBox(918, 800, 150)).toEqual({ width: 480, height: 90 });
    expect(singleTileBox(918, 1920, 1080)).toEqual({ width: 480, height: 270 }); // landscape at the cap
    expect(singleTileBox(918, 400, 900)).toEqual({ width: 213, height: 480 }); // portrait: height = the cap
  });

  it("no upscale: a small image stays its own size", () => {
    expect(singleTileBox(918, 64, 64)).toEqual({ width: 64, height: 64 });
    expect(singleTileBox(918, 240, 150)).toEqual({ width: 240, height: 150 });
  });

  it("a huge image is capped, not row-wide — the window can no longer grow it", () => {
    expect(singleTileBox(918, 4000, 3000)).toEqual({ width: 480, height: 360 });
    expect(singleTileBox(1600, 4000, 3000)).toEqual({ width: 480, height: 360 });
  });

  it("the box rides the window: a narrower row lowers the cap", () => {
    expect(singleTileBox(400, 800, 600)).toEqual({ width: 400, height: 300 });
    expect(singleTileBox(300, 1920, 1080)).toEqual({ width: 300, height: 169 });
  });

  it("the cap floors at MIN_TILE_SIDE — past it the tile overflows instead of shrinking", () => {
    expect(singleTileBox(60, 1920, 1080)).toEqual({ width: MIN_TILE_SIDE, height: 68 });
  });

  it("unknown natural size → the square placeholder (the live cap)", () => {
    expect(singleTileBox(600, 0, 0)).toEqual({ width: 480, height: 480 });
    expect(singleTileBox(240, 0, 0)).toEqual({ width: 240, height: 240 });
    expect(singleTileBox(80, 0, 0)).toEqual({ width: MIN_TILE_SIDE, height: MIN_TILE_SIDE });
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
    expect(tiles[0]?.width).toBe(MIN_TILE_SIDE); // the floor, not a crumbled square
  });

  it("mosaicHeight: row vs grid with the 4px gaps", () => {
    expect(mosaicHeight(computeMosaicTiles(3, 416))).toBe(136);
    expect(mosaicHeight(computeMosaicTiles(6, 408))).toBe(3 * 202 + 2 * 4); // 3 rows + gaps
    expect(mosaicHeight([])).toBe(0);
  });
});

describe("reservedVideoThumbBox", () => {
  it("a 1080p landscape preview peaks at 466 wide — the card's OUTER edge is flush with the single picture's 480", () => {
    expect(reservedVideoThumbBox(918, 1920, 1080)).toEqual({ width: 466, height: 262 });
    expect(reservedVideoThumbBox(918, 1920, 1080).width + VIDEO_CARD_CHROME)
      .toBe(singleTileBox(918, 1920, 1080).width); // 480 — singles and videos level
  });

  it("a portrait preview keeps the height cap and its own aspect", () => {
    expect(reservedVideoThumbBox(918, 1080, 1920)).toEqual({ width: 270, height: 480 });
  });

  it("the box rides the window: a narrower row shrinks the preview with its card", () => {
    // 400-wide row → outer card exactly 400, level with a single picture at 400.
    expect(reservedVideoThumbBox(400, 1920, 1080)).toEqual({ width: 386, height: 217 });
    expect(reservedVideoThumbBox(400, 1920, 1080).width + VIDEO_CARD_CHROME).toBe(400);
  });

  it("the width cap floors at MIN_TILE_SIDE (the preview's own floor, past it the card overflows)", () => {
    expect(reservedVideoThumbBox(80, 1920, 1080)).toEqual({ width: MIN_TILE_SIDE, height: 68 });
  });

  it("unknown dimensions fall back to the 16:9 plate off the live cap", () => {
    expect(reservedVideoThumbBox(918, 0, 0)).toEqual({ width: 466, height: 262 });
    expect(reservedVideoThumbBox(300, 0, 0)).toEqual({ width: 286, height: 161 }); // 300-14, 16:9
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
