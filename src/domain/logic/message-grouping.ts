/**
 * Pure message-grouping rules (Discord-style): a message CONTINUES the previous
 * group when the author is the same and the gap fits the window; otherwise it
 * STARTS a group (own avatar + name + timestamp header). Kept as a pure transform
 * over a minimal projection — the store maps wire messages into it, the renderer
 * never re-derives grouping inline.
 */

import { tf, type UiLang } from "../i18n/i18n";

export interface GroupableMessage {
  id: number;
  authorUsername: string;
  createdAtEpochMs: number;
}

/** Discord uses a 5-minute window. */
export const GROUP_GAP_MS = 5 * 60_000;

export function computeGroupStarts(messages: readonly GroupableMessage[], gapMs: number = GROUP_GAP_MS): boolean[] {
  const flags: boolean[] = [];
  let previous: GroupableMessage | null = null;
  for (const message of messages) {
    // A local OPTIMISTIC temp row (negative id — the optimistic send) always
    // starts a group: its own header is where the failure glyph lives, and the
    // server row that replaces it re-groups naturally anyway.
    flags.push(message.id < 0
      || previous === null
      || previous.authorUsername !== message.authorUsername
      || message.createdAtEpochMs - previous.createdAtEpochMs > gapMs);
    previous = message;
  }
  return flags;
}

/** True when `newer` extends `older`'s group — the pair must NOT be split by a
 *  pagination boundary (a cut mid-group makes the group's head flip to a
 *  continuation on every back-fill — "the group redraws", live report). */
export function continuesGroup(older: GroupableMessage, newer: GroupableMessage, gapMs: number = GROUP_GAP_MS): boolean {
  return older.authorUsername === newer.authorUsername
    && newer.createdAtEpochMs - older.createdAtEpochMs <= gapMs;
}

/** Wire createdAt (ISO string) → epoch ms, the grouping input. */
export function toEpochMs(createdAtIso: string): number {
  const parsed = Date.parse(createdAtIso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Cached formatters: Intl.DateTimeFormat CONSTRUCTION is the expensive part of
 *  timestamp rendering (locale databases are resolved per instance) — rows used
 *  to build 1-2 of these per render. Since the localization round the cache is
 *  keyed by the UI language (dates follow the LANGUAGE setting, not the OS —
 *  otherwise a RU interface shows English months); the key set is the fixed
 *  two-language catalog, so entries never invalidate. */
const TIME_OF_DAY_FORMATTERS = new Map<UiLang, Intl.DateTimeFormat>();
const MONTH_FORMATTERS = new Map<UiLang, Intl.DateTimeFormat>();

function timeOfDayFormatter(lang: UiLang): Intl.DateTimeFormat {
  let formatter = TIME_OF_DAY_FORMATTERS.get(lang);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" });
    TIME_OF_DAY_FORMATTERS.set(lang, formatter);
  }
  return formatter;
}

function monthFormatter(lang: UiLang): Intl.DateTimeFormat {
  let formatter = MONTH_FORMATTERS.get(lang);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(lang, { month: "short" });
    MONTH_FORMATTERS.set(lang, formatter);
  }
  return formatter;
}

/** "14:05" local time for the group head (locale-dependent by design, not unit-tested). */
export function formatTimeOfDay(epochMs: number, lang: UiLang = "en"): string {
  return timeOfDayFormatter(lang).format(epochMs);
}

/** oak's message-header stamp: "Today at 14:05" / "Yesterday at 14:05" / "Sep 4
 *  at 14:05" (RU: «Сегодня в 14:05»…). relativeDates=false (oak Appearance)
 *  always shows the full date. */
export function formatHeaderStamp(epochMs: number, nowMs: number, relativeDates = true, lang: UiLang = "en"): string {
  const date = new Date(epochMs);
  const now = new Date(nowMs);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (relativeDates && sameDay(date, now)) {
    return tf(lang, "dates.todayAt", { time });
  }
  const yesterday = new Date(nowMs - 86_400_000);
  if (relativeDates && sameDay(date, yesterday)) {
    return tf(lang, "dates.yesterdayAt", { time });
  }
  return tf(lang, "dates.monthDayAt", { month: monthFormatter(lang).format(date), day: date.getDate(), time });
}
