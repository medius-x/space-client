import { EN } from "./en";
import type { MessageKey, Translator } from "./i18n";

/**
 * The permission catalog's dictionary helpers (the PERMISSION_INFO map's
 * successor, localization round 2026-10-27). Labels and one-line descriptions
 * live in the en/ru dictionaries under `permissions.<BIT>.label/.description`;
 * this module maps a WIRE bit name to them.
 *
 * The wire set is OPEN — the server may ship bits this client build does not
 * know yet (the retired EMBED_LINKS era, future additions). An unknown bit
 * falls back to its raw enum name and an empty description, the exact shape
 * the old `PERMISSION_INFO[entry.name] ?? { label: entry.name, description: "" }`
 * lookup produced. test/i18n.test.ts walks KNOWN_PERMISSION_BITS against both
 * dictionaries so a new bit here cannot miss its keys.
 */
export const KNOWN_PERMISSION_BITS: readonly string[] = [
  "ADMINISTRATOR",
  "MANAGE_SERVER",
  "MANAGE_ROLES",
  "MANAGE_CHANNELS",
  "MANAGE_MEMBERS",
  "KICK_MEMBERS",
  "BAN_MEMBERS",
  "MANAGE_NICKNAMES",
  "CHANGE_NICKNAME",
  "VIEW_AUDIT_LOG",
  "MANAGE_EMOJIS",
  "SEND_MESSAGES",
  "MANAGE_MESSAGES",
  "ATTACH_FILES",
  "READ_MESSAGE_HISTORY",
  "MENTION_EVERYONE",
  "ADD_REACTIONS",
  "CONNECT",
  "SPEAK",
  "MUTE_MEMBERS",
  "DEAFEN_MEMBERS",
  "MOVE_MEMBERS",
  "USE_VAD",
  "PRIORITY_SPEAKER",
  "STREAM",
  "REQUEST_TO_SPEAK",
  "VIEW_CHANNEL",
  "MANAGE_STORAGE",
  "RESTRICT_PRIVATE_MESSAGES",
];

/** The human name of a permission bit (unknown bits fall back to the raw enum name). */
export function permissionLabel(t: Translator, bit: string): string {
  const key = `permissions.${bit}.label` as MessageKey;
  return key in EN ? t(key) : bit;
}

/** The one-line description of a permission bit (unknown bits have none — always visible row, never a broken one). */
export function permissionDescription(t: Translator, bit: string): string {
  const key = `permissions.${bit}.description` as MessageKey;
  return key in EN ? t(key) : "";
}
