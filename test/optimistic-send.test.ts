import { describe, expect, it } from "vitest";
import { computeGroupStarts, type GroupableMessage } from "../src/domain/logic/message-grouping";
import { lastServerMessageId, MessageStore } from "../src/domain/stores/MessageStore";
import type { Message } from "../src/types";

function message(id: number, channelId = 1, author = "alice", content?: string): Message {
  return {
    id,
    channelId,
    authorId: author === "alice" ? 7 : 9,
    authorUsername: author,
    content: content ?? `m${id}`,
    createdAt: new Date(id * 1000).toISOString(),
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
    sticker: null,
  };
}

function pending(store: MessageStore, content: string, key = "key"): Message {
  return store.appendPending(1, {
    content,
    authorId: 7,
    authorUsername: "alice",
    replyToId: null,
    idempotencyKey: key,
  });
}

/** The server's copy of an optimistic row: same author, same content, a real id. */
function serverCopyOf(temp: Message, id: number): Message {
  return message(id, temp.channelId, temp.authorUsername, temp.content ?? undefined);
}

describe("optimistic send (MessageStore)", () => {
  it("parks the temp row after the server tail with a negative id and pending delivery", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), message(2)]);

    const temp = pending(store, "hello");
    expect(temp.id).toBeLessThan(0);
    expect(temp.delivery).toBe("pending");
    expect(store.listFor(1).map((row) => row.id)).toEqual([1, 2, temp.id]);
    expect(store.listFor(1)[2]?.delivery).toBe("pending");
    expect(store.listFor(1)[2]?.idempotencyKey).toBe("key");
  });

  it("resolvePending retires the temp row and inserts the server row", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);

    const temp = pending(store, "hello");
    const created = serverCopyOf(temp, 3);
    expect(store.resolvePending(1, temp.id, created)).toBe(true);
    expect(store.listFor(1).map((row) => row.id)).toEqual([2, 3]);
    expect(store.listFor(1).some((row) => row.id === temp.id)).toBe(false);
  });

  it("the STOMP echo can win the race: applyLive absorbs the temp row, the late 201 is a no-op", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);

    const temp = pending(store, "hello");
    const echo = serverCopyOf(temp, 3);
    expect(store.applyLive(echo)).toBe(true); // echo first
    expect(store.listFor(1).map((row) => row.id)).toEqual([2, 3]); // temp absorbed, no double row

    expect(store.resolvePending(1, temp.id, echo)).toBe(false); // late 201: id already there
    expect(store.listFor(1).map((row) => row.id)).toEqual([2, 3]);
  });

  it("duplicate texts absorb FIFO: two \"ok\" temps, two echoes, no leftovers", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);

    const first = pending(store, "ok", "k1");
    const second = pending(store, "ok", "k2");
    store.applyLive(message(3, 1, "alice", "ok")); // first echo
    store.applyLive(message(4, 1, "alice", "ok")); // second echo
    expect(store.listFor(1).map((row) => row.id)).toEqual([2, 3, 4]);
    expect(store.listFor(1).some((row) => row.id === first.id || row.id === second.id)).toBe(false);
  });

  it("another author's same text never absorbs a temp row", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    pending(store, "hi");

    store.applyLive(message(3, 1, "bob", "hi"));
    const ids = store.listFor(1).map((row) => row.id);
    expect(ids).toContain(3);
    expect(ids.filter((id) => id < 0)).toHaveLength(1); // alice's temp survives
  });

  it("a failed row keeps its text: markPendingDelivery and removePendingMessage", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);

    const temp = pending(store, "will fail");
    expect(store.markPendingDelivery(1, temp.id, "failed")).toBe(true);
    expect(store.listFor(1).find((row) => row.id === temp.id)?.delivery).toBe("failed");

    expect(store.markPendingDelivery(1, temp.id, "pending")).toBe(true); // retry re-marks
    expect(store.listFor(1).find((row) => row.id === temp.id)?.delivery).toBe("pending");

    expect(store.removePendingMessage(1, temp.id)).toBe(true);
    expect(store.listFor(1).map((row) => row.id)).toEqual([2]);
  });

  it("pendingMessageById returns temp rows only — server ids are not eligible", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    const temp = pending(store, "x");

    expect(store.pendingMessageById(1, temp.id)?.content).toBe("x");
    expect(store.pendingMessageById(1, 2)).toBeNull();
    expect(store.removePendingMessage(1, 2)).toBe(false); // a server row is untouchable
  });

  it("mergeTail (the reconnect heal) absorbs the temp row its fresh page confirms", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    const temp = pending(store, "sent right before the drop");

    const fresh = store.mergeTail(1, [serverCopyOf(temp, 3)]);
    expect(fresh.map((row) => row.id)).toEqual([3]);
    expect(store.listFor(1).map((row) => row.id)).toEqual([2, 3]);
  });

  it("applySnapshot keeps SURVIVING temp rows but absorbs the ones the page confirms", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    const inFlight = pending(store, "still flying");
    const confirmed = pending(store, "already landed");
    store.applyLive(serverCopyOf(confirmed, 3)); // its server copy arrived

    store.applySnapshot(1, [message(2), serverCopyOf(confirmed, 3)]); // refetch
    const ids = store.listFor(1).map((row) => row.id);
    expect(ids).toEqual([2, 3, inFlight.id]); // confirmed absorbed, in-flight survives at the tail
  });

  it("applySnapshotAround keeps surviving temp rows through a window replace", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    const inFlight = pending(store, "flying over the jump");

    store.applySnapshotAround(1, [message(1)]);
    expect(store.listFor(1).map((row) => row.id)).toEqual([1, inFlight.id]);
  });

  it("the around guard compares against the last SERVER id, not a parked temp row", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    store.applySnapshotAround(1, [message(2)]);
    pending(store, "optimistic in an around channel"); // parked temp tail

    // Before the fix this dropped EVERY live row (any id > the temp's negative id).
    expect(store.applyLive(message(1))).toBe(true); // inside the window — inserts
    expect(store.applyLive(message(3))).toBe(false); // newer than the window — dropped
  });

  it("appendPage keeps temp rows parked at the tail of the older-page concat", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(3)]);
    const temp = pending(store, "tail");
    expect(store.appendPage(1, [message(3), message(4)])).toBe(1);
    expect(store.listFor(1).map((row) => row.id)).toEqual([3, 4, temp.id]);
  });
});

describe("optimistic send (helpers)", () => {
  it("lastServerMessageId skips temp rows — a negative id never reaches an ack or a cursor", () => {
    expect(lastServerMessageId([])).toBeNull();
    expect(lastServerMessageId([message(1), message(2)])).toBe(2);
    const store = new MessageStore();
    store.applySnapshot(1, [message(2)]);
    const temp = pending(store, "x");
    expect(lastServerMessageId(store.listFor(1))).toBe(2);
    expect(lastServerMessageId([message(1), temp])).toBe(1);
    expect(lastServerMessageId([temp])).toBeNull();
  });

  it("a temp row always starts its own group (the failure glyph's anchor)", () => {
    const sameAuthor: GroupableMessage[] = [
      { id: 1, authorUsername: "alice", createdAtEpochMs: 0 },
      { id: 2, authorUsername: "alice", createdAtEpochMs: 1000 }, // continuation of 1
      { id: -1, authorUsername: "alice", createdAtEpochMs: 2000 }, // temp — head
    ];
    expect(computeGroupStarts(sameAuthor)).toEqual([true, false, true]);
  });
});
