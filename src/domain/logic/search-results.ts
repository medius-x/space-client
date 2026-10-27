import type { Message } from "../../types";
import { tf, type UiLang } from "../i18n/i18n";

/**
 * Pure helpers for the search panel (#481): hit highlighting, one-line previews
 * and the day grouping of result cards. Kept React-free and regex-free — an
 * indexOf loop treats the query as a LITERAL substring, so LIKE metacharacters
 * and regex specials cost nothing (the server escapes the same characters in
 * its ILIKE pattern).
 */

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** Case-insensitive substring split of the content around every query hit —
 *  feeds the result card's <mark> rendering. A null/empty query (the author-only
 *  search) yields one plain segment. */
export function highlightSegments(content: string | null, query: string | null): HighlightSegment[] {
  const body = content ?? "";
  const needle = (query ?? "").trim();
  if (needle.length === 0 || body.length === 0) {
    return [{ text: body, hit: false }];
  }
  const lowerBody = body.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let matchIndex = lowerBody.indexOf(lowerNeedle);
  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      segments.push({ text: body.slice(cursor, matchIndex), hit: false });
    }
    segments.push({ text: body.slice(matchIndex, matchIndex + needle.length), hit: true });
    cursor = matchIndex + needle.length;
    matchIndex = lowerBody.indexOf(lowerNeedle, cursor);
  }
  if (cursor < body.length) {
    segments.push({ text: body.slice(cursor), hit: false });
  }
  return segments;
}

/** One-line search preview: newlines flatten to spaces, capped with "…". The cap
 *  is applied AFTER flattening; an attachment-only message previews empty (the
 *  card renders its file names separately). */
export function flattenForSearch(content: string | null, cap = 120): string {
  const flat = (content ?? "").replaceAll("\n", " ").trim();
  return flat.length <= cap ? flat : flat.slice(0, cap) + "…";
}

export interface SearchDayGroup {
  label: string;
  items: Message[];
}

/** The day caption for a result group header: calendar-local Today / Yesterday /
 *  "Sep 4" (+ the year when it differs — Discord shows the full date there).
 *  Localized since 2026-10-27 — the month follows the UI language, not the OS. */
export function formatSearchDayStamp(epochMs: number, nowMs: number, lang: UiLang = "en"): string {
  const date = new Date(epochMs);
  const now = new Date(nowMs);
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(date, now)) {
    return tf(lang, "dates.today");
  }
  const yesterday = new Date(nowMs - 86_400_000);
  if (sameDay(date, yesterday)) {
    return tf(lang, "dates.yesterday");
  }
  const month = new Intl.DateTimeFormat(lang, { month: "short" }).format(date);
  const suffix = date.getFullYear() === now.getFullYear() ? "" : `, ${date.getFullYear()}`;
  return tf(lang, "dates.monthDay", { month, day: date.getDate(), suffix });
}

/** Groups newest-first results into consecutive day buckets (a bucket per calendar
 *  day, in arrival order — no re-sorting). */
export function groupSearchResultsByDay(messages: readonly Message[], nowMs: number, lang: UiLang = "en"): SearchDayGroup[] {
  const groups: SearchDayGroup[] = [];
  for (const message of messages) {
    const epochMs = Date.parse(message.createdAt);
    const label = formatSearchDayStamp(Number.isFinite(epochMs) ? epochMs : nowMs, nowMs, lang);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.items.push(message);
    } else {
      groups.push({ label, items: [message] });
    }
  }
  return groups;
}
