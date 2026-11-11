import type { MessageKey } from "../domain/i18n/i18n";
import type { ActivityKind } from "../types";

/**
 * The renderer-side bridge from an activity's verb to its localized prefix:
 * the literal-key table keeps the i18n type safety (the ServerSettingsPane
 * reasonKeys idiom) — a dynamic string would widen the Translator's key union.
 */
export const ACTIVITY_MESSAGE_KEYS: Record<ActivityKind, MessageKey> = {
  playing: "activity.playing",
  listening: "activity.listening",
  watching: "activity.watching",
  streaming: "activity.streaming",
  competing: "activity.competing",
};
