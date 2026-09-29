import { describe, expect, it } from "vitest";
import { filterStickerPacks, stickerEstimateExtra, stickerForwardFileName } from "../src/domain/logic/sticker-picker";
import type { Sticker, StickerPack } from "../src/types";

function stickerOf(id: number, name: string): Sticker {
  return { id, name, url: null, key: `stickers/u/${name}.png`, uploadedBy: 1 };
}

function packOf(id: number, name: string, stickers: Sticker[]): StickerPack {
  return { id, name, stickers };
}

describe("filterStickerPacks (the tray search)", () => {
  it("a blank query passes every pack through", () => {
    const packs = [packOf(1, "Cats", [stickerOf(1, "cat")]), packOf(2, "Dogs", [])];
    expect(filterStickerPacks(packs, "")).toEqual(packs);
    expect(filterStickerPacks(packs, "   ")).toEqual(packs);
  });

  it("a query matches sticker names case-insensitively and keeps only hit packs", () => {
    const packs = [
      packOf(1, "Cats", [stickerOf(1, "lolcat"), stickerOf(2, "serious")]),
      packOf(2, "Dogs", [stickerOf(3, "doge")]),
    ];
    const filtered = filterStickerPacks(packs, "CAT");
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.name).toBe("Cats");
    expect(filtered[0]?.stickers.map((sticker) => sticker.name)).toEqual(["lolcat"]);
  });

  it("a pack whose stickers all miss the query is dropped", () => {
    const packs = [packOf(1, "Cats", [stickerOf(1, "cat")])];
    expect(filterStickerPacks(packs, "doge")).toEqual([]);
  });
});

describe("stickerEstimateExtra (the virtual-list prepayment)", () => {
  it("null sticker pays nothing, a present one pays the render block", () => {
    expect(stickerEstimateExtra(null)).toBe(0);
    expect(stickerEstimateExtra({ name: "cat", key: "stickers/u/cat.png", url: null })).toBe(176);
  });
});

describe("stickerForwardFileName (the cross-instance sticker forward)", () => {
  it("takes the original file name off the key tail", () => {
    expect(stickerForwardFileName({ name: "cat", key: "stickers/u1/cat.gif" })).toBe("cat.gif");
  });

  it("a dotless tail falls back to .png — the tile classifier needs an extension", () => {
    expect(stickerForwardFileName({ name: "cat", key: "stickers/u1/cat" })).toBe("cat.png");
  });
});
