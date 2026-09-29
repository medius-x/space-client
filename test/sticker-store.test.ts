import { describe, expect, it } from "vitest";
import { StickerStore } from "../src/domain/stores/StickerStore";
import type { Sticker, StickerPack } from "../src/types";

function stickerOf(id: number, name: string): Sticker {
  return { id, name, url: `http://minio/${name}.png`, key: `stickers/u/${name}.png`, uploadedBy: 1 };
}

function packOf(id: number, name: string, stickers: Sticker[]): StickerPack {
  return { id, name, stickers };
}

describe("StickerStore (the live sticker catalog)", () => {
  it("applySnapshot sorts the packs, flattens the stickers and exposes byId", () => {
    const store = new StickerStore();
    store.applySnapshot([
      packOf(2, "Dogs", [stickerOf(21, "dog")]),
      packOf(1, "Cats", [stickerOf(12, "zebra"), stickerOf(11, "cat")]),
    ]);
    const snapshot = store.getSnapshot();
    expect(snapshot.packs.map((pack) => pack.name)).toEqual(["Cats", "Dogs"]);
    // The flat list keeps the PACK order (it feeds lookups, not the tray's grouping).
    expect(snapshot.stickers.map((sticker) => sticker.name)).toEqual(["cat", "zebra", "dog"]);
    expect(snapshot.byId.get(11)?.name).toBe("cat");
    expect(snapshot.totalStickers).toBe(3);
  });

  it("the derived map keeps IDENTITY between snapshots (the useStore contract)", () => {
    const store = new StickerStore();
    store.applySnapshot([packOf(1, "Cats", [stickerOf(11, "cat")])]);
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(second.byId).toBe(first.byId);
    expect(second.stickers).toBe(first.stickers);
  });

  it("a new snapshot rebuilds the lookups — a fresh id appears, a gone one disappears", () => {
    const store = new StickerStore();
    store.applySnapshot([packOf(1, "Cats", [stickerOf(11, "cat")])]);
    store.applySnapshot([packOf(2, "Dogs", [stickerOf(21, "dog")])]);
    const snapshot = store.getSnapshot();
    expect(snapshot.byId.has(11)).toBe(false);
    expect(snapshot.byId.get(21)?.name).toBe("dog");
    expect(snapshot.totalStickers).toBe(1);
  });

  it("markUnsupported empties the catalog and flags the server as feature-less", () => {
    const store = new StickerStore();
    store.applySnapshot([packOf(1, "Cats", [stickerOf(11, "cat")])]);
    store.markUnsupported();
    const snapshot = store.getSnapshot();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.byId.size).toBe(0);
  });
});
