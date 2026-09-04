import type { Message, ReplyInfo } from "../../types";

/**
 * Live patching of reply-quote trees. The server pushes nothing when a QUOTED
 * message changes — the client patches its own copies (oak parity). The walk is
 * recursive (ReplyInfo nests), shares every untouched subtree BY REFERENCE, and
 * returns the ORIGINAL array when nothing matched — idempotent against the WS echo.
 */

/** Client mirror of the server's reply-preview flattening (≤100 chars + ellipsis). */
export const REPLY_PREVIEW_MAX = 100;

export function buildReplyPreview(content: string | null): string {
  const text = content ?? "";
  return text.length > REPLY_PREVIEW_MAX ? `${text.slice(0, REPLY_PREVIEW_MAX)}…` : text;
}

/** The patch returns null when the level is already in the target shape (idempotency). */
type LevelPatch = (matched: ReplyInfo) => ReplyInfo | null;

function patchReplyLevel(level: ReplyInfo, targetId: number, patch: LevelPatch): ReplyInfo | null {
  // null = nothing changed in this subtree.
  if (level.messageId === targetId) {
    return patch(level);
  }
  const nested = level.reply !== null ? patchReplyLevel(level.reply, targetId, patch) : null;
  if (nested === null) {
    return null;
  }
  return { ...level, reply: nested };
}

function patchForwardSnapshots(
  forward: NonNullable<Message["forward"]>,
  targetId: number,
  patch: LevelPatch,
): NonNullable<Message["forward"]> | null {
  const nested = forward.reply !== null ? patchReplyLevel(forward.reply, targetId, patch) : null;
  return nested === null ? null : { ...forward, reply: nested };
}

function patchMessage(message: Message, targetId: number, patch: LevelPatch): Message | null {
  let nextMessage: Message | null = null;
  if (message.reply !== null) {
    const patched = patchReplyLevel(message.reply, targetId, patch);
    if (patched !== null) {
      nextMessage = { ...message, reply: patched };
    }
  }
  if (message.forward !== null) {
    const patchedForward = patchForwardSnapshots(message.forward, targetId, patch);
    if (patchedForward !== null) {
      nextMessage = { ...nextMessage ?? message, forward: patchedForward };
    }
  }
  return nextMessage;
}

/** A quoted message was deleted → its quote levels flip to the deleted marker. */
export function patchReplyTreesForDeleted(messages: readonly Message[], deletedId: number): readonly Message[] {
  return patchList(messages, deletedId, (matched) =>
    matched.deleted ? null : { ...matched, deleted: true, preview: "" });
}

/** A quoted message was edited → refresh its quote levels from the .edited push. */
export function patchReplyTreesForEdited(messages: readonly Message[], edited: Message): readonly Message[] {
  return patchList(messages, edited.id, (matched) => {
    const next: ReplyInfo = {
      ...matched,
      preview: buildReplyPreview(edited.content),
      authorUsername: edited.authorUsername,
      createdAt: edited.createdAt,
      deleted: false,
      // The edited message's own quote tree, canonical from the server push.
      reply: edited.reply,
    };
    return next.preview === matched.preview && next.authorUsername === matched.authorUsername
      && next.deleted === matched.deleted && next.reply === matched.reply
      ? null
      : next;
  });
}

function patchList(messages: readonly Message[], targetId: number, patch: LevelPatch): readonly Message[] {
  let changed = false;
  const next = messages.map((message) => {
    const patched = patchMessage(message, targetId, patch);
    if (patched !== null) {
      changed = true;
      return patched;
    }
    return message;
  });
  return changed ? next : messages;
}
