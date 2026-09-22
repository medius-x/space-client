import type { Message } from "../../types";

/** The pin card's one-line snippet budget (chars). */
export const PIN_SNIPPET_MAX = 120;

/** The carousel index the card starts on: the LATEST pin (the list is pinnedAt-ASC,
 *  so the last element). count 0 has no card at all (the component renders null). */
export function defaultPinIndex(count: number): number {
  return Math.max(0, count - 1);
}

/** Step the carousel by delta with wrap-around on both ends. */
export function stepPinIndex(index: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return ((index + delta) % count + count) % count;
}

/** One-line snippet of a pinned message: newlines flatten to spaces, capped at
 *  PIN_SNIPPET_MAX chars with an ellipsis; an attachment-only message falls back
 *  to its FIRST file name (the reply-preview discipline). */
export function pinSnippet(message: Message, maxChars = PIN_SNIPPET_MAX): string {
  let body = message.content ?? "";
  if (body.trim().length === 0) {
    const firstAttachment = message.attachments[0];
    body = firstAttachment === undefined ? "" : firstAttachment.fileName;
  }
  const flat = body.replace(/\n/g, " ").trim();
  if (flat.length <= maxChars) {
    return flat;
  }
  return flat.slice(0, maxChars) + "…";
}
