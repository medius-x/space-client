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
 *
 * Discord-style formatting markers are the OUTERMOST text pass: "**bold with a
 * https://link inside**" works, and marker characters that sit inside a URL
 * itself are not markers (a URL with stars in its path survives intact). The
 * pass recurses into its own content — nesting like "**bold *and italic* **" is
 * supported. The wire stays a plain string: an old client just sees the markers
 * as text (the same tradeoff as ":name:" tokens). Inline code is TERMINAL —
 * nothing inside a backtick pair is parsed further (no emojis, no nested
 * markers), and it never spans a newline.
 */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: MentionInfo }
  | { kind: "link"; text: string; url: string }
  | { kind: "emoji"; text: string; name: string }
  | { kind: "formatted"; format: FormatKind; children: MessageSegment[] };

export type FormatKind = "bold" | "italic" | "underline" | "strike" | "spoiler" | "code";

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

/**
 * The formatting pass: Discord markers over a text run. Longer markers
 * are matched first ("***" before "**" before "*"), and a closing marker is only
 * valid when it does not touch another instance of its own character on either
 * side — that is what makes "*a **b** c*" close on the LAST star (the inner pair
 * belongs to bold), and what leaves a bare run of asterisks as plain text.
 */
const FORMAT_MARKERS: readonly { token: string; format: FormatKind }[] = [
  { token: "***", format: "bold" }, // ***x*** = bold wrapping an italic — Discord's combo
  { token: "__", format: "underline" },
  { token: "**", format: "bold" },
  { token: "~~", format: "strike" },
  { token: "||", format: "spoiler" },
  { token: "`", format: "code" },
  { token: "*", format: "italic" },
];
const FORMAT_TRIGGER = /[*_~|`]/;

function matchMarkerAt(text: string, index: number): { token: string; format: FormatKind } | null {
  for (const marker of FORMAT_MARKERS) {
    if (text.startsWith(marker.token, index)) {
      return marker;
    }
  }
  return null;
}

/** Start of the closing marker, or -1. A candidate touching the same character
 *  (a longer run like "a***b") is skipped — it opens/closes a different pair. */
function findClosingMarker(text: string, token: string, searchFrom: number): number {
  let position = searchFrom;
  for (;;) {
    const found = text.indexOf(token, position);
    if (found === -1) {
      return -1;
    }
    const touchesBefore = found > 0 && text[found - 1] === token[0];
    const touchesAfter = text[found + token.length] === token[0];
    if (!touchesBefore && !touchesAfter) {
      return found;
    }
    position = found + 1;
  }
}

/** Non-empty; the content must hug its markers (no leading/trailing whitespace —
 *  "2 * 3 * 4" stays plain math) and inline code stays on ONE line. */
function isValidContent(content: string, format: FormatKind): boolean {
  if (content.length === 0) {
    return false;
  }
  if (format === "code") {
    return !content.includes("\n");
  }
  return !/\s/.test(content[0]!) && !/\s/.test(content[content.length - 1]!);
}

/** Marker characters inside a URL are not markers — a URL with stars in its
 *  path must survive intact. The forbidden ranges mirror exactly what
 *  splitLinks will carve out on the leaf (pattern match minus trailing
 *  punctuation). */
function urlRanges(text: string): [number, number][] {
  if (!text.includes("http")) {
    return []; // fast path — the URL pattern needs the scheme
  }
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    if (trimmed.length > 0) {
      ranges.push([start, start + trimmed.length]);
    }
  }
  return ranges;
}

function parseFormatting(text: string, emojiNames: ReadonlySet<string> | undefined): MessageSegment[] {
  const pushLeafText = (chunks: MessageSegment[], chunk: string): void => {
    if (chunk.length === 0) {
      return;
    }
    const leaf = splitLinks(chunk);
    if (emojiNames === undefined || emojiNames.size === 0) {
      chunks.push(...leaf);
    } else {
      chunks.push(...leaf.flatMap((segment) => segment.kind === "text" ? splitEmojis(segment.text, emojiNames) : [segment]));
    }
  };
  if (!FORMAT_TRIGGER.test(text)) {
    const fast: MessageSegment[] = [];
    pushLeafText(fast, text); // no marker character at all — links/emojis only
    return fast;
  }
  const urls = urlRanges(text);
  const insideUrl = (position: number): boolean =>
    urls.some(([start, end]) => position >= start && position < end);
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const marker = !insideUrl(index) ? matchMarkerAt(text, index) : null;
    if (marker !== null) {
      // A closing candidate inside a URL is skipped like a touching run
      let closeStart = findClosingMarker(text, marker.token, index + marker.token.length);
      while (closeStart !== -1 && insideUrl(closeStart)) {
        closeStart = findClosingMarker(text, marker.token, closeStart + 1);
      }
      const content = closeStart === -1 ? "" : text.slice(index + marker.token.length, closeStart);
      if (closeStart !== -1 && isValidContent(content, marker.format)) {
        pushLeafText(segments, text.slice(cursor, index));
        segments.push({
          kind: "formatted",
          format: marker.format,
          children: marker.format === "code"
            // TERMINAL: the code span's inner text is never re-parsed — no
            // emojis, no nested markers, no links
            ? [{ kind: "text", text: content }]
            // "***x***" is bold wrapping an italic: re-parse the content with
            // the single-star pair restored, so the combo nests for real
            : marker.token === "***"
              ? parseFormatting(`*${content}*`, emojiNames)
              : parseFormatting(content, emojiNames),
        });
        index = closeStart + marker.token.length;
        cursor = index;
        continue;
      }
    }
    index += 1;
  }
  pushLeafText(segments, text.slice(cursor));
  return segments;
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
      segments.push(...parseFormatting(content.slice(cursor, mention.start), emojiNames));
    }
    segments.push({ kind: "mention", text: content.slice(mention.start, mention.end), mention });
    cursor = mention.end;
  }
  if (cursor < content.length) {
    segments.push(...parseFormatting(content.slice(cursor), emojiNames));
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
