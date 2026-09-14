/**
 * One-line toast preview: collapse whitespace (multi-line content becomes one
 * line), truncate to 80 chars with an ellipsis. Mention NAMES stay — the user
 * explicitly wants to see WHO was pinged in the preview (user decision,
 * 2026-09-15; oak strips @tokens, we deliberately don't). Pure — unit-tested.
 */
export const TOAST_PREVIEW_MAX_CHARS = 80;

export function toastPreview(content: string | null): string {
  if (content === null || content.trim() === "") {
    return "";
  }
  const text = content.trim().replaceAll(/\s+/g, " ");
  return text.length > TOAST_PREVIEW_MAX_CHARS ? `${text.slice(0, TOAST_PREVIEW_MAX_CHARS)}…` : text;
}

/** One preview segment: a span that pings THE RECIPIENT carries the flag so the
 *  toast can tint it soft-blurple; everything else — other people's mentions,
 *  plain @words — stays unlit (user decision: only MY nick highlights). */
export interface ToastPreviewSegment {
  text: string;
  mention: boolean;
}

/** Who the recipient is on this instance — the "does this ping ME" filter. */
export interface ToastPreviewSelf {
  userId: number | null;
  roleIds: readonly number[];
  suppressEveryoneHere: boolean;
}

/** A mention targets the recipient: a direct @user by id, an @role they hold,
 *  or an unsuppressed @everyone/@here. */
function mentionTargetsSelf(
  mention: { type: string; id: number | null },
  self: ToastPreviewSelf | undefined,
): boolean {
  if (self === undefined) {
    return false; // no identity resolved — tint nothing (better grey than a false ping)
  }
  if (mention.type === "USER") {
    return self.userId !== null && mention.id === self.userId;
  }
  if (mention.type === "ROLE") {
    return mention.id !== null && self.roleIds.includes(mention.id);
  }
  if (mention.type === "EVERYONE" || mention.type === "HERE") {
    return !self.suppressEveryoneHere;
  }
  return false;
}

/** The preview SPLIT BY mention offsets: spans the server recognized AND that
 *  target the recipient carry the tint flag; overlapping/malformed ranges are
 *  skipped (chat's segmenter rules). Whitespace collapses per segment; the
 *  80-char budget is shared, and the ellipsis rides as its own plain segment. */
export function toastPreviewSegments(
  content: string | null,
  mentions: readonly { type: string; id: number | null; start: number; end: number }[],
  self?: ToastPreviewSelf,
): ToastPreviewSegment[] {
  if (content === null || content.trim() === "") {
    return [];
  }
  const valid = mentions
    .filter((mention) => mention.start >= 0 && mention.end > mention.start && mention.end <= content.length)
    .sort((left, right) => left.start - right.start);
  const segments: ToastPreviewSegment[] = [];
  let cursor = 0;
  let budget = TOAST_PREVIEW_MAX_CHARS;
  let truncated = false;
  const push = (raw: string, mention: boolean): void => {
    if (truncated || budget <= 0 || raw.trim() === "") {
      return;
    }
    const collapsed = raw.replaceAll(/\s+/g, " ");
    if (collapsed.length <= budget) {
      segments.push({ text: collapsed, mention });
      budget -= collapsed.length;
      return;
    }
    segments.push({ text: collapsed.slice(0, budget), mention });
    budget = 0;
    truncated = true;
  };
  for (const mention of valid) {
    if (mention.start < cursor) {
      continue; // overlaps an already-consumed span
    }
    push(content.slice(cursor, mention.start), false);
    push(content.slice(mention.start, mention.end), mentionTargetsSelf(mention, self));
    cursor = mention.end;
    if (truncated) {
      break;
    }
  }
  if (!truncated) {
    push(content.slice(cursor), false);
  }
  if (truncated) {
    segments.push({ text: "…", mention: false });
  }
  return segments;
}

/** The toast's dim header line: "Server  #channel" (oak's two-space separator),
 *  falling back to whichever half exists — an empty string hides the line. */
export function toastServerHeader(serverName: string, channelName: string): string {
  const server = serverName.trim();
  const channel = channelName.trim();
  if (server === "") {
    return channel;
  }
  if (channel === "") {
    return server;
  }
  return `${server}  ${channel}`;
}

/** The header for a DM toast (oak's evaluateNotification): a GROUP shows its
 *  name, a 1:1 shows NONE of its own (the author line is the peer already);
 *  a message from a non-active instance is tagged with that server's name. */
export function dmToastHeader(instanceTag: string, dm: { type: "DM" | "GROUP_DM" }, displayName: string): string {
  if (dm.type !== "GROUP_DM") {
    return instanceTag;
  }
  return toastServerHeader(instanceTag, displayName);
}
