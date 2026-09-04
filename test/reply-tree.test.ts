import { describe, expect, it } from "vitest";
import { buildReplyPreview, patchReplyTreesForDeleted, patchReplyTreesForEdited } from "../src/domain/logic/reply-tree";
import type { Message, ReplyInfo } from "../src/types";

function replyLevel(messageId: number, author: string, overrides: Partial<ReplyInfo> = {}): ReplyInfo {
  return {
    messageId,
    authorId: messageId,
    authorUsername: author,
    preview: `preview-${messageId}`,
    createdAt: "2026-01-01T00:00:00Z",
    deleted: false,
    forward: null,
    reply: null,
    ...overrides,
  };
}

function message(id: number, reply: ReplyInfo | null, channelId = 1): Message {
  return {
    id,
    channelId,
    authorId: id,
    authorUsername: `user${id}`,
    content: `content-${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply,
    forward: null,
  };
}

describe("patchReplyTreesForDeleted", () => {
  it("flips the matching quote level to the deleted marker and shares untouched rows", () => {
    const quoteOf5 = replyLevel(5, "alice");
    const original = [message(1, quoteOf5), message(2, null), message(3, replyLevel(9, "bob"))];

    const patched = patchReplyTreesForDeleted(original, 5);

    expect(patched).not.toBe(original); // something changed
    expect(patched[0]?.reply?.deleted).toBe(true);
    expect(patched[0]?.reply?.preview).toBe("");
    expect(patched[1]).toBe(original[1]); // untouched row keeps its reference
    expect(patched[2]).toBe(original[2]); // a different quote tree untouched

    // Idempotent: a WS echo of the same deletion finds nothing new to do.
    expect(patchReplyTreesForDeleted(patched, 5)).toBe(patched);
  });

  it("patches NESTED quote levels and shares unchanged subtrees", () => {
    const inner = replyLevel(7, "carol");
    const outer = replyLevel(5, "alice", { reply: inner });
    const original = [message(1, outer)];

    const patched = patchReplyTreesForDeleted(original, 7);

    const patchedOuter = patched[0]?.reply;
    expect(patchedOuter?.deleted).toBe(false); // the outer level is untouched…
    expect(patchedOuter).not.toBe(outer); // …but its parent chain is rebuilt
    expect(patchedOuter?.reply?.deleted).toBe(true); // the inner level matched
    expect(patchReplyTreesForDeleted(original, 99)).toBe(original); // no match → same ref
  });
});

describe("patchReplyTreesForEdited", () => {
  it("refreshes preview/author from the edited push and adopts its nested tree", () => {
    const original = [message(1, replyLevel(5, "alice"))];
    const editedSource = message(5, replyLevel(4, "dave"));
    editedSource.content = "x".repeat(150);

    const patched = patchReplyTreesForEdited(original, editedSource);

    const level = patched[0]?.reply;
    expect(level?.preview).toBe(`${"x".repeat(100)}…`);
    expect(level?.authorUsername).toBe("user5");
    expect(level?.reply?.messageId).toBe(4); // adopted from the .edited push
  });
});

describe("buildReplyPreview", () => {
  it("mirrors the server's 100-char flattening", () => {
    expect(buildReplyPreview("short")).toBe("short");
    const exactly100 = "a".repeat(100);
    expect(buildReplyPreview(exactly100)).toBe(exactly100);
    expect(buildReplyPreview(`${exactly100}tail`)).toBe(`${exactly100}…`);
  });
});
