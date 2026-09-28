import type { CustomEmoji } from "../../types";
import type { MessageSegment } from "./mention-segmenter";

/**
 * Pure helpers of the emoji picker (composer) and the upload form (settings) —
 * kept out of the components for unit testing.
 */

/** Derives a default catalog name from an upload's file name: lowercase, extension
 *  stripped, anything outside [a-z0-9_-] collapsed to "-", trimmed of separators,
 *  clamped to the 32-char server limit. Empty when nothing usable remains — the
 *  caller then demands manual input. */
export function emojiNameFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, "");
  const collapsed = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return collapsed;
}

/** The catalog filtered by a picker query (case-insensitive substring on the name;
 *  an empty/blank query shows everything). */
export function filterEmojis(emojis: readonly CustomEmoji[], query: string): CustomEmoji[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...emojis];
  }
  return emojis.filter((emoji) => emoji.name.toLowerCase().includes(needle));
}

/** Discord's "jumbo" rule: a message that consists of nothing but custom-emoji
 *  tokens (whitespace gaps allowed) renders them LARGE instead of inline-size.
 *  Segments already carry the catalog resolution (an unknown token stays text),
 *  so a deleted emoji degrades the row back to plain rendering for free. */
export function isEmojiOnlyMessage(segments: readonly MessageSegment[]): boolean {
  return segments.length > 0 && segments.every(
    (segment) => segment.kind === "emoji"
      || (segment.kind === "text" && segment.text.trim() === ""),
  );
}

/** The user-tunable jumbo size (client-only setting, Settings → Appearance):
 *  the minimum visually equals the inline text-height emoji (~18px at the 13px
 *  chat font), the default matches Discord's jumboable, the cap keeps rows
 *  sane. Applies to the reader's own rendering only — everyone else keeps
 *  their own preference. */
export const JUMBO_EMOJI_MIN_PX = 18;
export const JUMBO_EMOJI_MAX_PX = 96;
export const JUMBO_EMOJI_DEFAULT_PX = 48;

/** Clamps a stored/entered value into the legal range; garbage → default. */
export function clampJumboEmojiSize(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return JUMBO_EMOJI_DEFAULT_PX;
  }
  return Math.min(JUMBO_EMOJI_MAX_PX, Math.max(JUMBO_EMOJI_MIN_PX, Math.round(value)));
}

/** Extra height a POTENTIALLY-jumbo row adds on top of the flat one-line text
 *  estimate, so the virtual list does not jump when measurement replaces the
 *  estimate (the 2026-09-25 media-round lesson, applied preventively). Zero
 *  at/below the proven 48px — a 48px jumbo image fits inside a normal head
 *  row (verified live: no scroll drift) — then grows linearly with the image.
 *  The regex is the segmentation's superset: whitespace-separated :name:
 *  tokens only. A token missing from the catalog renders as text (slightly
 *  over-estimated until measured) — deletion is rare, the delta is small. */
export function jumboEmojiEstimateExtra(content: string | null, jumboPx: number): number {
  if (content === null || !/^(?:\s*:[a-z0-9_-]{1,32}:\s*)+$/.test(content)) {
    return 0;
  }
  return Math.max(0, jumboPx - JUMBO_EMOJI_DEFAULT_PX);
}
