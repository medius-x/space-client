import { describe, expect, it } from "vitest";
import {
  computeMosaicTiles,
  isAudioFile,
  isImageFile,
  isVideoFile,
  mosaicHeight,
} from "../src/domain/logic/attachment-layout";

describe("computeMosaicTiles", () => {
  it("single image: one capped tile", () => {
    const tiles = computeMosaicTiles(1, 600);
    expect(tiles).toEqual([{ width: 420, height: 280 }]);
    expect(computeMosaicTiles(1, 300)).toEqual([{ width: 300, height: 280 }]); // clamped to container
  });

  it("2–3 images: one row, widths split the container", () => {
    const two = computeMosaicTiles(2, 416);
    expect(two).toHaveLength(2);
    expect(two[0]?.width).toBe(204); // (416 - 8) / 2
    expect(two[1]?.width).toBe(204);
    expect(computeMosaicTiles(3, 416)).toHaveLength(3);
    expect(computeMosaicTiles(3, 416)[0]?.width).toBe(133); // (416 - 16) / 3
  });

  it("4+: a 2-column square grid", () => {
    const tiles = computeMosaicTiles(6, 408);
    expect(tiles).toHaveLength(6);
    expect(tiles[0]?.width).toBe(200);
    expect(tiles[0]?.height).toBe(200);
  });

  it("empty and tiny containers degrade safely", () => {
    expect(computeMosaicTiles(0, 500)).toEqual([]);
    const tiles = computeMosaicTiles(3, 10);
    expect(tiles[0]?.width).toBeGreaterThan(0);
  });

  it("mosaicHeight: row vs grid", () => {
    expect(mosaicHeight(computeMosaicTiles(3, 416))).toBe(200);
    expect(mosaicHeight(computeMosaicTiles(6, 408))).toBe(3 * 200 + 2 * 8); // 3 rows + gaps
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
