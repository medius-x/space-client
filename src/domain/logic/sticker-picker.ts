import type { StickerPack, StickerRef } from "../../types";

/**
 * Pure helpers of the sticker tray (composer) — kept out of the components for unit
 * testing (the emoji-picker precedent). The upload form's default-name derivation is
 * NOT duplicated here: it reuses emojiNameFromFileName (the ASCII ladder is the same).
 */

/** The packs filtered by a tray query (case-insensitive substring on a STICKER name;
 *  an empty/blank query shows everything). A pack with zero matching stickers is
 *  dropped while the query is non-blank — empty sections read as noise. */
export function filterStickerPacks(packs: readonly StickerPack[], query: string): StickerPack[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...packs];
  }
  return packs
    .map((pack) => ({
      ...pack,
      stickers: pack.stickers.filter((sticker) => sticker.name.toLowerCase().includes(needle)),
    }))
    .filter((pack) => pack.stickers.length > 0);
}

/** Discord's standard sticker render height (px). */
export const STICKER_RENDER_PX = 160;

/** Extra height a sticker-carrying row adds on top of the flat text estimate, so the
 *  virtual list does not jump when measurement replaces the estimate (the media-round
 *  lesson; the render height is FIXED, so the estimate never drifts on decode). */
export function stickerEstimateExtra(sticker: StickerRef | null): number {
  return sticker !== null ? STICKER_RENDER_PX + 16 : 0;
}

/** The display fileName for a cross-instance sticker forward: the original file name
 *  rides the tail of the object key ({@code stickers/<uuid>/<name>}); a dotless tail
 *  (paranoia) falls back to ".png" — the receiving client's tile classifier needs an
 *  image extension to render it. */
export function stickerForwardFileName(sticker: { name: string; key: string }): string {
  const tail = sticker.key.split("/").pop() ?? "";
  return tail.includes(".") ? tail : `${sticker.name}.png`;
}
