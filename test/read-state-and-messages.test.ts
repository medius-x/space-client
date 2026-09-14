import { describe, expect, it, vi } from "vitest";
import { ReadStateStore } from "../src/domain/stores/ReadStateStore";
import { MessageStore } from "../src/domain/stores/MessageStore";
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
  // Self identity: userId 2 matches the USER mention below; role 11 feeds the ROLE case.
  const SELF = { userId: 2, roleIds: [11] };

  it("seeds from the server snapshot, bumps on live, acks to zero", () => {
    const store = new ReadStateStore();
    store.applySnapshot([
      { channelId: 1, unreadCount: 5, mentionCount: 2, lastReadMessageId: 10, lastMessageId: 15 },
    ]);
    expect(store.get(1)).toEqual({ unreadCount: 5, mentionCount: 2, lastReadMessageId: 10 });

    // Watching the channel in a focused window — nothing counts.
    expect(store.bumpLive(message(16, 1), SELF, true, true)).toBe(false);
    expect(store.get(1).unreadCount).toBe(5);

    // Channel open but window unfocused (reading something else) — still unread.
    expect(store.bumpLive(message(17, 1), SELF, true, false)).toBe(true);
    expect(store.get(1).unreadCount).toBe(6);

    // A mention bumps the red counter too.
    store.bumpLive(
      message(18, 1, [{ type: "USER", id: 2, name: "alice", start: 0, end: 6 }]),
      SELF,
      false,
      false,
    );
    expect(store.get(1).mentionCount).toBe(3);

    // Ack clears both and remembers the pointer.
    store.ack(1, 18);
    expect(store.get(1)).toEqual({ unreadCount: 0, mentionCount: 0, lastReadMessageId: 18 });

    // A channel never seeded (a DM created after the read-states snapshot) seeds
    // itself from zero — the first unread message still counts (live M6 smoke).
    expect(store.bumpLive(message(50, 9), SELF, false, false)).toBe(true);
    expect(store.get(9)).toEqual({ unreadCount: 1, mentionCount: 0, lastReadMessageId: null });
  });

  it("an @role the user holds bumps the red counter (oak parity)", () => {
    const store = new ReadStateStore();
    store.applySnapshot([{ channelId: 1, unreadCount: 0, mentionCount: 0, lastReadMessageId: 3, lastMessageId: 3 }]);
    store.bumpLive(message(4, 1, [{ type: "ROLE", id: 11, name: "admin", start: 0, end: 6 }]), SELF, false, false);
    expect(store.get(1).mentionCount).toBe(1);
    // A role the user does NOT hold stays grey.
    store.bumpLive(message(5, 1, [{ type: "ROLE", id: 99, name: "mods", start: 0, end: 5 }]), SELF, false, false);
    expect(store.get(1).mentionCount).toBe(1);
    expect(store.get(1).unreadCount).toBe(2);
  });

  it("emits only on real changes", () => {
    const store = new ReadStateStore();
    store.applySnapshot([{ channelId: 1, unreadCount: 0, mentionCount: 0, lastReadMessageId: 3, lastMessageId: 3 }]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.ack(1, 3); // already read at 3 — no-op
    expect(listener).not.toHaveBeenCalled();
  });

  it("DM rule: forceMention bumps the red counter even without an @ (mention-equivalent)", () => {
    const store = new ReadStateStore();
    store.applySnapshot([{ channelId: 7, unreadCount: 0, mentionCount: 0, lastReadMessageId: 3, lastMessageId: 3 }]);
    store.bumpLive(message(4, 7), SELF, false, false, true); // DM, no mention inside
    expect(store.get(7)).toEqual({ unreadCount: 1, mentionCount: 1, lastReadMessageId: 3 });
    // Same message in a normal channel stays grey (no @, no force flag).
    store.applySnapshot([{ channelId: 8, unreadCount: 0, mentionCount: 0, lastReadMessageId: 3, lastMessageId: 3 }]);
    store.bumpLive(message(4, 8), SELF, false, false, false);
    expect(store.get(8).mentionCount).toBe(0);
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

