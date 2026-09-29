/** Pure logic of the unified reaction picker (phase 3: custom emojis as reactions).
 *  A custom reaction rides on the wire as a colon-wrapped ":name:" token in the same
 *  string field as the bare built-in slugs — the discriminator is structural (built-in
 *  slugs never contain colons), so ":heart:" and "heart" are two different reactions.
 *  The same slug vocabulary is the shared MRU of "Latest" expressions (reactions and
 *  composer emoji inserts, both pickers). */

import { REACTION_GLYPH_BY_SLUG, type CustomEmoji } from "../../types";

/** One built-in reaction entry — the client mirror of the server's REACTION_SLUGS
 *  whitelist (REACTION_CATALOG is structurally this type). */
export interface BuiltInReaction {
  slug: string;
  glyph: string;
}

/** How many recently used expressions the Latest row keeps (user decision: 8). */
export const RECENT_EXPRESSIONS_CAP = 8;

/** Records a used expression into the MRU: the fresh slug moves to the front,
 *  duplicates collapse, the list stays capped. */
export function pushRecentExpression(list: readonly string[], slug: string): string[] {
  return [slug, ...list.filter((entry) => entry !== slug)].slice(0, RECENT_EXPRESSIONS_CAP);
}

/** Load-time sanitize of the persisted list (hand-edited KV, a renamed slug): keeps
 *  only valid expression slugs — a known built-in or a well-formed ":name:" token —
 *  dedups, caps. */
export function sanitizeRecentExpressions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || seen.has(entry)) {
      continue;
    }
    const isBuiltin = Object.prototype.hasOwnProperty.call(REACTION_GLYPH_BY_SLUG, entry);
    if (!isBuiltin && customEmojiNameOfReactionSlug(entry) === null) {
      continue;
    }
    seen.add(entry);
    valid.push(entry);
  }
  return valid.slice(0, RECENT_EXPRESSIONS_CAP);
}

/** One renderable Latest entry: exactly one of the two payload fields is set. Dead
 *  customs (the emoji left the catalog) are dropped by the resolver, not rendered. */
export interface RecentExpressionEntry {
  /** The slug form — what a click toggles/records back. */
  slug: string;
  /** The unicode glyph (built-in entries). */
  glyph: string | null;
  /** The catalog emoji (custom entries). */
  emoji: CustomEmoji | null;
}

/** Resolves the persisted Latest slugs into renderable tiles against the LIVE
 *  catalog: built-ins through the glyph map, customs through byName (a deleted emoji
 *  silently drops out until re-uploaded). A non-empty query keeps only matching
 *  entries — the row behaves like the sections below it, not a frozen shortcut. */
export function resolveRecentExpressionEntries(
  slugs: readonly string[],
  byName: ReadonlyMap<string, CustomEmoji>,
  query = "",
): RecentExpressionEntry[] {
  const needle = query.trim().toLowerCase();
  const matches = (label: string): boolean => needle === "" || label.toLowerCase().includes(needle);
  const entries: RecentExpressionEntry[] = [];
  for (const slug of slugs) {
    const customName = customEmojiNameOfReactionSlug(slug);
    if (customName !== null) {
      const emoji = byName.get(customName);
      if (emoji !== undefined && matches(emoji.name)) {
        entries.push({ slug, glyph: null, emoji });
      }
      continue;
    }
    const glyph = REACTION_GLYPH_BY_SLUG[slug];
    if (glyph !== undefined && matches(slug)) {
      entries.push({ slug, glyph, emoji: null });
    }
  }
  return entries;
}

/** Unwraps a ":name:" custom-emoji reaction slug to the catalog name; null for a
 *  built-in slug (bare, no colons) or anything malformed. Mirrors the server-side
 *  grammar [a-z0-9_-]{1,32} (MessageService.CUSTOM_REACTION_SLUG). */
export function customEmojiNameOfReactionSlug(slug: string): string | null {
  const match = /^:([a-z0-9_-]{1,32}):$/.exec(slug);
  return match !== null ? match[1]! : null;
}

/** The built-in catalog filtered by the picker query (case-insensitive substring on
 *  the slug — the only text a built-in has). An empty/blank query shows everything. */
export function filterBuiltInReactions(
  catalog: readonly BuiltInReaction[],
  query: string,
): BuiltInReaction[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...catalog];
  }
  return catalog.filter((entry) => entry.slug.toLowerCase().includes(needle));
}

/** The reaction picker's footprint — the same fixed width as the composer picker. */
export const REACTION_PICKER_WIDTH_PX = 372;
export const REACTION_PICKER_MAX_HEIGHT_PX = 420;
const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 4;

/** Position for the FIXED reaction picker: clamped into the viewport horizontally;
 *  opened BELOW the anchor point, flipped UP when the space below is short (the
 *  message sits near the window bottom), vertically clamped as the last resort —
 *  the CSS max-height keeps the fallback from ever clipping. */
export function reactionPickerPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(x, viewportWidth - REACTION_PICKER_WIDTH_PX - VIEWPORT_MARGIN_PX),
  );
  const heightWithGap = REACTION_PICKER_MAX_HEIGHT_PX + ANCHOR_GAP_PX;
  if (y + heightWithGap <= viewportHeight - VIEWPORT_MARGIN_PX) {
    return { left, top: y + ANCHOR_GAP_PX };
  }
  if (y - heightWithGap >= VIEWPORT_MARGIN_PX) {
    return { left, top: y - heightWithGap };
  }
  const lowestTop = viewportHeight - heightWithGap - VIEWPORT_MARGIN_PX;
  return { left, top: Math.max(VIEWPORT_MARGIN_PX, Math.min(y, lowestTop)) };
}
