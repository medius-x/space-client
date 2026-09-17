import { describe, expect, it, vi } from "vitest";
import { MessageStore } from "../src/domain/stores/MessageStore";
import type { Message } from "../src/types";

function message(id: number, channelId = 1, author = "alice"): Message {
  return {
    id,
    channelId,
    authorId: id,
    authorUsername: author,
    content: `m${id}`,
    createdAt: new Date(id * 1000).toISOString(),
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
  };
}

describe("MessageStore", () => {
  it("listFor returns a STABLE reference until that channel changes", () => {
    const store = new MessageStore();
    const before = store.listFor(1);
    expect(before).toEqual([]);

    store.applySnapshot(1, [message(1), message(2)]);
    const list = store.listFor(1);
    expect(list.map((entry) => entry.id)).toEqual([1, 2]);

    const listener = vi.fn();
    store.subscribe(listener);
    const snapshotBefore = store.getSnapshot();
    store.applySnapshot(2, [message(1, 2)]); // unrelated channel
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.listFor(1)).toBe(list); // channel 1 untouched → same array
    expect(store.getSnapshot()).toBe(snapshotBefore); // the store itself is the snapshot
    expect(store.listFor(2).map((entry) => entry.id)).toEqual([1]);
  });

  it("applyLive dedups the echo of the sender's own REST response", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), message(2)]);

    expect(store.applyLive(message(2))).toBe(false); // exact echo of the tail
    expect(store.applyLive(message(5))).toBe(true); // normal append
    expect(store.applyLive(message(5))).toBe(false); // STOMP echo of the same id
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([1, 2, 5]);
  });

  it("applyLive repairs out-of-order delivery by inserting at the id-sorted position", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), message(2), message(5)]);

    expect(store.applyLive(message(3))).toBe(true);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([1, 2, 3, 5]);
  });

  it("applyLive drops messages for channels whose history is not loaded", () => {
    const store = new MessageStore();
    expect(store.applyLive(message(9, 42))).toBe(false);
    expect(store.listFor(42)).toEqual([]);

    store.applySnapshot(42, [message(1, 42)]);
    expect(store.applyLive(message(9, 42))).toBe(true); // now it sticks
  });

  it("prependPage dedups the overlap and returns the number actually prepended", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(3), message(4), message(5)]);

    const prepended = store.prependPage(1, [message(1), message(2), message(3)]); // 3 overlaps
    expect(prepended).toBe(2);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);

    expect(store.prependPage(1, [message(3)])).toBe(0); // pure overlap → no-op, no emit churn
    expect(store.prependPage(1, [])).toBe(0);
  });

  it("dropChannel forgets the list and its loaded flag", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1)]);
    store.dropChannel(1);
    expect(store.listFor(1)).toEqual([]);
    expect(store.isLoaded(1)).toBe(false);
    expect(store.applyLive(message(2, 1))).toBe(false);
  });

  it("mergeTail heals a reconnect gap: batched id-merge, one emit, only the missed returned", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(1), message(2), message(3)]);
    const listener = vi.fn();
    store.subscribe(listener);

    // The refetched newest page overlaps the tail we already hold and adds 4-5.
    const fresh = store.mergeTail(1, [message(2), message(3), message(4), message(5)]);
    expect(fresh.map((entry) => entry.id)).toEqual([4, 5]); // exactly what the WS gap swallowed
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(listener).toHaveBeenCalledTimes(1); // batched — N messages, ONE emit

    expect(store.mergeTail(1, [message(4), message(5)])).toEqual([]); // clean repeat is a no-op
    expect(listener).toHaveBeenCalledTimes(1);

    // An unloaded channel never merges (opening it refetches a full page).
    expect(store.mergeTail(9, [message(10, 9)])).toEqual([]);
    expect(store.loadedChannelIds()).toEqual([1]);
  });
});
