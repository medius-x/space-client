import { Emitter } from "../lib/store";
import type { Sticker, StickerPack } from "../../types";

export interface StickerState {
  /** Name-ordered packs, each with its name-ordered stickers (server contract). */
  packs: readonly StickerPack[];
  /** The same stickers flattened and name-ordered across packs. */
  stickers: readonly Sticker[];
  /** Derived lookup carried IN the snapshot so useStore selectors can return it by
   *  identity (rebuilding a Map inside a selector is the infinite-rerender trap; it
   *  rebuilds only in applySnapshot — the EmojiStore contract). */
  byId: ReadonlyMap<number, Sticker>;
  /** Precomputed for the settings counter. */
  totalStickers: number;
  /** false when the server predates the feature (GET /api/sticker-packs → 404): the
   *  tray button and the settings section hide themselves. */
  supported: boolean;
}

const EMPTY_STATE: StickerState = {
  packs: [],
  stickers: [],
  byId: new Map(),
  totalStickers: 0,
  supported: true,
};

/**
 * The live custom-sticker catalog (packs with nested stickers). The composer tray and
 * the Server Settings → Stickers section both render straight from the wire shape —
 * the snapshot's derived flat list/byId exist for lookups, the packs ARE the grouping.
 */
export class StickerStore extends Emitter {
  private state: StickerState = EMPTY_STATE;

  getSnapshot = (): StickerState => this.state;

  applySnapshot(packs: readonly StickerPack[]): void {
    // Defensive ordering: the server already sends name-ordered packs AND stickers,
    // but the tray/settings render straight from this snapshot — never trust wire order.
    const sortedPacks = [...packs]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((pack) => ({
        ...pack,
        stickers: [...pack.stickers].sort((left, right) => left.name.localeCompare(right.name)),
      }));
    const flatStickers = sortedPacks.flatMap((pack) => pack.stickers);
    this.state = {
      ...this.state,
      packs: sortedPacks,
      stickers: flatStickers,
      byId: new Map(flatStickers.map((sticker) => [sticker.id, sticker] as const)),
      totalStickers: flatStickers.length,
    };
    this.emit();
  }

  markUnsupported(): void {
    this.state = { ...EMPTY_STATE, supported: false };
    this.emit();
  }
}
