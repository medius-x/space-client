import type { MentionInfo } from "../../types";

/**
 * Splits a message body into text/mention segments for rendering. The server's
 * mentions carry [start, end) offsets into the content; malformed ranges and
 * overlaps are tolerated (sorted by start, an overlapping mention is dropped).
 */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: MentionInfo };

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
      segments.push({ kind: "text", text: content.slice(cursor, mention.start) });
    }
    segments.push({ kind: "mention", text: content.slice(mention.start, mention.end), mention });
    cursor = mention.end;
  }
  if (cursor < content.length) {
    segments.push({ kind: "text", text: content.slice(cursor) });
  }
  return segments;
}
