import type { MessageKey, Translator } from "../domain/i18n/i18n";
import type { ActivityKind, PresenceActivity } from "../types";

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

/** The GAME-line glyph (user request 2026-11-19): an IGDB-detected game carries
 *  a gamepad instead of the localized "playing" prefix — shorter than the verb
 *  (long game names fit the roster row) and instantly readable as a game. */
export const GAMEPAD_GLYPH = "🎮";

/** The roster/settings line for an activity: the localized prefix and the
 *  name, glued with one space — or the bare name when the kind has no prefix.
 *  An IGDB game line (igdbGameId set) prefixes the gamepad glyph instead. */
export function formatActivityLine(t: Translator, activity: Pick<PresenceActivity, "type" | "name" | "igdbGameId">): string {
  if (activity.igdbGameId != null) {
    return `${GAMEPAD_GLYPH} ${activity.name}`;
  }
  const prefix = t(ACTIVITY_MESSAGE_KEYS[activity.type]);
  return prefix.length > 0 ? `${prefix} ${activity.name}` : activity.name;
}
