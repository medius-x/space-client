import { describe, expect, it, vi } from "vitest";
import { ReadStateStore } from "../src/domain/stores/ReadStateStore";
import { MessageStore } from "../src/domain/stores/MessageStore";
import {
  buildCumulativeOffsets,
  computeWindow,
  indexAtOffset,
  offsetForIndexAlignCenter,
  offsetForIndexAlignStart,
} from "../src/domain/logic/virtual-window";
import type { Message } from "../src/types";

function message(id: number, channelId = 1, mentions: Message["mentions"] = []): Message {
  return {
    id,
    channelId,
    authorId: id,
    authorUsername: "alice",
    content: `m${id}`,
    createdAt: new Date(id * 1000).toISOString(),
    attachments: [],
    mentions,
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
  };
}

describe("ReadStateStore", () => {
  it("seeds from the server snapshot, bumps on live, acks to zero", () => {
    const store = new ReadStateStore();
    store.applySnapshot([
      { channelId: 1, unreadCount: 5, mentionCount: 2, lastReadMessageId: 10, lastMessageId: 15 },
    ]);
    expect(store.get(1)).toEqual({ unreadCount: 5, mentionCount: 2, lastReadMessageId: 10 });

    // Watching the channel in a focused window — nothing counts.
    expect(store.bumpLive(message(16, 1), "alice", true, true)).toBe(false);
    expect(store.get(1).unreadCount).toBe(5);

    // Channel open but window unfocused (reading something else) — still unread.
    expect(store.bumpLive(message(17, 1), "alice", true, false)).toBe(true);
    expect(store.get(1).unreadCount).toBe(6);

    // A mention bumps the red counter too.
    store.bumpLive(
      message(18, 1, [{ type: "USER", id: 2, name: "alice", start: 0, end: 6 }]),
      "alice",
      false,
      false,
    );
    expect(store.get(1).mentionCount).toBe(3);

    // Ack clears both and remembers the pointer.
    store.ack(1, 18);
    expect(store.get(1)).toEqual({ unreadCount: 0, mentionCount: 0, lastReadMessageId: 18 });

    // Unrelated channel — nothing to count against (never seeded/acked).
    expect(store.bumpLive(message(50, 9), "alice", false, false)).toBe(false);
  });

  it("emits only on real changes", () => {
    const store = new ReadStateStore();
    store.applySnapshot([{ channelId: 1, unreadCount: 0, mentionCount: 0, lastReadMessageId: 3, lastMessageId: 3 }]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.ack(1, 3); // already read at 3 — no-op
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("MessageStore M2 mutations", () => {
  it("applyEdited replaces the row and refreshes quoting trees", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), message(2), Object.assign(message(3), {
      reply: { messageId: 1, authorId: 1, authorUsername: "alice", preview: "m1", createdAt: "t", deleted: false, forward: null, reply: null },
    })]);

    const edited = message(1);
    edited.content = "rewritten";
    expect(store.applyEdited(edited)).toBe(true);

    const list = store.listFor(1);
    expect(list[0]?.content).toBe("rewritten");
    expect(list[2]?.reply?.preview).toBe("rewritten");

    expect(store.applyEdited(message(99, 1))).toBe(false); // unknown id — no-op
  });

  it("applyDeleted removes the row and marks its quotes deleted", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), Object.assign(message(2), {
      reply: { messageId: 1, authorId: 1, authorUsername: "alice", preview: "m1", createdAt: "t", deleted: false, forward: null, reply: null },
    })]);

    expect(store.applyDeleted(1, 1)).toBe(true);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([2]);
    expect(store.listFor(1)[0]?.reply?.deleted).toBe(true);
    expect(store.applyDeleted(1, 1)).toBe(false);
  });

  it("applyReactions replaces the snapshot row", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1)]);
    const reactions = [{ reaction: "heart", count: 2, userIds: [1, 2], usernames: ["a", "b"] }];
    expect(store.applyReactions(1, 1, reactions)).toBe(true);
    expect(store.listFor(1)[0]?.reactions).toBe(reactions);
    expect(store.applyReactions(1, 99, reactions)).toBe(false);
  });
});

describe("virtual-window math", () => {
  const heights = [40, 60, 40, 100, 40, 40, 40];
  const offsets = buildCumulativeOffsets(heights);

  it("cumulative offsets", () => {
    expect(offsets.length).toBe(heights.length + 1);
    expect(offsets[0]).toBe(0);
    expect(offsets[2]).toBe(100);
    expect(offsets[offsets.length - 1]).toBe(heights.reduce((sum, height) => sum + height, 0));
  });

  it("indexAtOffset binary-searches and clamps", () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 99)).toBe(1);
    expect(indexAtOffset(offsets, 100)).toBe(2);
    expect(indexAtOffset(offsets, 10_000)).toBe(heights.length - 1); // clamp
  });

  it("computeWindow covers the viewport plus overscan", () => {
    const range = computeWindow({ offsets, scrollTop: 100, viewportHeight: 80, overscan: 1 });
    // Visible raw: items 2..3 (100..280 covers 80px viewport → items 2,3); ±1 overscan.
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(4);

    expect(computeWindow({ offsets: new Float64Array(1), scrollTop: 0, viewportHeight: 100, overscan: 2 }))
      .toEqual({ startIndex: 0, endIndex: -1 }); // empty list
  });

  it("alignment offsets", () => {
    expect(offsetForIndexAlignStart(offsets, 2)).toBe(100);
    // item 3: top 140, height 100 → centered in a 200px viewport: 140 − (200−100)/2 = 90
    expect(offsetForIndexAlignCenter(offsets, 3, 200)).toBe(90);
  });
});
