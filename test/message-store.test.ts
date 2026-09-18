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

  it("applySnapshotAround REPLACES the list and marks the channel around-without-tail", () => {
    const store = new MessageStore();
    store.applySnapshot(1, [message(40), message(41)]); // the tail we jump away from
    expect(store.isAroundWithoutTail(1)).toBe(false);

    store.applySnapshotAround(1, [message(10), message(11), message(12)]);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([10, 11, 12]); // tail discarded
    expect(store.isLoaded(1)).toBe(true);
    expect(store.isAroundWithoutTail(1)).toBe(true);
  });

  it("around window: live appends past the window's last id are dropped, in-window echoes insert", () => {
    const store = new MessageStore();
    store.applySnapshotAround(1, [message(10), message(11), message(12)]);

    // Newer than the window: lives in the unloaded gap (or the tail) — must not stitch a hole.
    expect(store.applyLive(message(50, 1))).toBe(false);
    expect(store.applyLive(message(13, 1))).toBe(false);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([10, 11, 12]);

    // Inside the window: normal binary insert (an echo / same-id race).
    expect(store.applyLive(message(11, 1, "bob"))).toBe(false); // echo dedup still applies
    expect(store.listFor(1).length).toBe(3);
  });

  it("appendPage dedups and appends the newer page below an around window", () => {
    const store = new MessageStore();
    store.applySnapshotAround(1, [message(10), message(12)]);
    // Out-of-order page contents still land id-sorted.
    const appended = store.appendPage(1, [message(16), message(13), message(12)]);
    expect(appended).toBe(2); // 12 overlaps
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([10, 12, 13, 16]);
    expect(store.appendPage(1, [])).toBe(0);
    expect(store.appendPage(1, [message(16)])).toBe(0); // pure overlap → no-op
  });

  it("markTailReached re-enables live appends; mergeTail skips while around", () => {
    const store = new MessageStore();
    store.applySnapshotAround(1, [message(10), message(12)]);

    // The reconnect heal must NOT stitch the window and the tail over the unloaded gap.
    expect(store.mergeTail(1, [message(11), message(50)])).toEqual([]);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([10, 12]);
    expect(store.applyLive(message(50, 1))).toBe(false);

    store.markTailReached(1);
    expect(store.isAroundWithoutTail(1)).toBe(false);
    expect(store.applyLive(message(50, 1))).toBe(true); // contiguous again
    expect(store.mergeTail(1, [message(60)])).toEqual([message(60)]);
    store.markTailReached(1); // idempotent — no emit churn
  });

  it("applySnapshot and dropChannel clear the around flag", () => {
    const store = new MessageStore();
    store.applySnapshotAround(1, [message(10)]);
    store.applySnapshot(1, [message(1), message(2)]); // "Jump to present" refetch
    expect(store.isAroundWithoutTail(1)).toBe(false);
    expect(store.applyLive(message(3, 1))).toBe(true); // appends legal again

    store.applySnapshotAround(1, [message(10)]);
    store.dropChannel(1);
    expect(store.isAroundWithoutTail(1)).toBe(false);
    expect(store.isLoaded(1)).toBe(false);
  });
});
