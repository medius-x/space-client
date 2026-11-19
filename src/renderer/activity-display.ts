import type { MessageKey, Translator } from "../domain/i18n/i18n";
import type { TranslateParams } from "../domain/i18n/i18n";
import type { ActivityKind, PresenceActivity } from "../types";
import type { MaterialGlyphName } from "./components/MaterialGlyph";

/**
 * The renderer-side bridge from an activity's verb to its localized prefix:
 * the literal-key table keeps the i18n type safety (the ServerSettingsPane
 * reasonKeys idiom) — a dynamic string would widen the Translator's key union.
 * The "custom" kind carries NO prefix (user request 2026-11-11): its key
 * translates to an empty string and formatActivityLine drops the glue.
 */
export const ACTIVITY_MESSAGE_KEYS: Record<ActivityKind, MessageKey> = {
  playing: "activity.playing",
  listening: "activity.listening",
  watching: "activity.watching",
  streaming: "activity.streaming",
  competing: "activity.competing",
  custom: "activity.custom",
};

/** The empty-prefix kind's own PICKER label (the option must not read blank). */
export const CUSTOM_KIND_LABEL_KEY: MessageKey = "activity.customLabel";

/** The activity KIND's Material Symbols glyph (user picks, 2026-11-19; the
 *  2026-11-19 smoke swapped competing to a trophy — scoreboard read as a
 *  scoreboard, not a contest): the manual-picker rows show these instead of
 *  the verb words; the tooltip still carries the localized verb. "custom" has
 *  NO glyph — its button keeps the text label (its line never carries a
 *  prefix at all). */
export const ACTIVITY_KIND_GLYPHS: Partial<Record<ActivityKind, MaterialGlyphName>> = {
  playing: "sports_esports",
  listening: "headphones",
  watching: "desktop_windows",
  streaming: "live_tv",
  competing: "trophy",
};

/** Compact playtime for the detected-games list: whole hours once there is at
 *  least one ("12 h" — the achievements are hour-shaped), minutes below that. */
export function formatPlaytime(
    t: Translator,
    unitHours: MessageKey,
    unitMinutes: MessageKey,
    totalSeconds: number,
): string {
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return t(unitHours, { count: hours });
  }
  return t(unitMinutes, { count: Math.floor(totalSeconds / 60) });
}

/** The roster/settings line for an activity as PLAIN TEXT: the localized
 *  prefix and the name, glued with one space — or the bare name when the kind
 *  has no prefix. An IGDB game line (igdbGameId set) is the bare name: its
 *  gamepad glyph (sports_esports, 2026-11-19 — was the 🎮 emoji) is ARTWORK,
 *  rendered by the ActivityLine component, not text. */
export function formatActivityLine(t: Translator, activity: Pick<PresenceActivity, "type" | "name" | "igdbGameId">): string {
  if (activity.igdbGameId != null) {
    return activity.name;
  }
  const prefix = t(ACTIVITY_MESSAGE_KEYS[activity.type]);
  return prefix.length > 0 ? `${prefix} ${activity.name}` : activity.name;
}
