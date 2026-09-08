import type { MentionInfo } from "../../types";

/**
 * Splits a message body into text/mention/link segments for rendering. The server's
 * mentions carry [start, end) offsets into the content; malformed ranges and
 * overlaps are tolerated (sorted by start, an overlapping mention is dropped).
 * Links live INSIDE the text gaps: http(s) words become link segments, trailing
 * punctuation stays text (oak's LinkHighlighter), and a mention always wins an
 * intersection because links never cross the mention ranges.
 */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: MentionInfo }
  | { kind: "link"; text: string; url: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

function splitLinks(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    if (trimmed.length === 0) {
      continue; // a bare "http://" — leave it as plain text
    }
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    segments.push({ kind: "link", text: trimmed, url: trimmed });
    cursor = start + trimmed.length; // the stripped punctuation lands in the next text run
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

export function segmentMessageContent(content: string | null, mentions: readonly MentionInfo[]): MessageSegment[] {
  if (content === null || content.length === 0) {
    return []; // nothing to render — mention offsets point into content that is not there
  }
  const valid = mentions
    .filter((mention) => mention.start >= 0 && mention.end > mention.start && mention.end <= content.length)
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const mention of valid) {
    if (mention.start < cursor) {
      continue; // overlaps the previous mention — the server never does this, tolerate anyway
    }
    if (mention.start > cursor) {
      segments.push(...splitLinks(content.slice(cursor, mention.start)));
    }
    segments.push({ kind: "mention", text: content.slice(mention.start, mention.end), mention });
    cursor = mention.end;
  }
  if (cursor < content.length) {
    segments.push(...splitLinks(content.slice(cursor)));
  }
  return segments;
}

/** The first http(s) URL of a body (the OG-preview target) or null — oak previews only the FIRST link. */
export function firstHttpUrl(content: string | null): string | null {
  if (content === null) {
    return null;
  }
  const match = content.match(URL_PATTERN);
  if (match === null) {
    return null;
  }
  return match[0]?.replace(TRAILING_PUNCTUATION, "") ?? null;
}
