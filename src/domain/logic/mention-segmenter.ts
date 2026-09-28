import type { MentionInfo } from "../../types";

/**
 * Splits a message body into text/mention/link/emoji segments for rendering. The server's
 * mentions carry [start, end) offsets into the content; malformed ranges and
 * overlaps are tolerated (sorted by start, an overlapping mention is dropped).
 * Links live INSIDE the text gaps: http(s) words become link segments, trailing
 * punctuation stays text (oak's LinkHighlighter), and a mention always wins an
 * intersection because links never cross the mention ranges.
 *
 * Custom emojis are the LAST pass inside the leftover text (after links — a URL's
 * ":8080:" port must never be cut) and only for tokens present in the live catalog
 * (the caller passes the name set; a token NOT in it stays plain text, so a deleted
 * emoji degrades its old messages to ":name:" text — the Discord tradeoff).
 */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: MentionInfo }
  | { kind: "link"; text: string; url: string }
  | { kind: "emoji"; text: string; name: string };

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

/** ":name:" tokens present in the catalog become emoji segments; everything else
 *  stays text. A non-member match rewinds the search to match.index + 1, so
 *  ":a:b:" still finds ":b:" when only b exists (the closing ':' of the failed
 *  pair may open the next token) — matchAll cannot do this, hence the exec loop. */
function splitEmojis(text: string, emojiNames: ReadonlySet<string>): MessageSegment[] {
  if (!text.includes(":")) {
    return [{ kind: "text", text }]; // fast path — no colon, no token
  }
  const segments: MessageSegment[] = [];
  const pattern = /:([a-z0-9_-]{1,32}):/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!emojiNames.has(match[1]!)) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "emoji", text: match[0], name: match[1]! });
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

function splitText(text: string, emojiNames: ReadonlySet<string> | undefined): MessageSegment[] {
  const linked = splitLinks(text);
  if (emojiNames === undefined || emojiNames.size === 0) {
    return linked;
  }
  return linked.flatMap((segment) => segment.kind === "text" ? splitEmojis(segment.text, emojiNames) : [segment]);
}

export function segmentMessageContent(
  content: string | null,
  mentions: readonly MentionInfo[],
  emojiNames?: ReadonlySet<string>,
): MessageSegment[] {
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
      segments.push(...splitText(content.slice(cursor, mention.start), emojiNames));
    }
    segments.push({ kind: "mention", text: content.slice(mention.start, mention.end), mention });
    cursor = mention.end;
  }
  if (cursor < content.length) {
    segments.push(...splitText(content.slice(cursor), emojiNames));
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
