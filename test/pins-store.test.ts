import { describe, expect, it, vi } from "vitest";
import { PinnedStore } from "../src/domain/stores/PinnedStore";
import { defaultPinIndex, pinSnippet, stepPinIndex } from "../src/domain/logic/pinned-view";
import type { Message } from "../src/types";

function message(id: number, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: 1,
    authorId: 10,
    authorUsername: "alice",
    content: `pinned text ${id}`,
    createdAt: `2026-09-22T00:00:${String(10 + id).padStart(2, "0")}Z`,
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: true,
    pinnedBy: "alice",
    pinnedAt: `2026-09-22T01:00:${String(10 + id).padStart(2, "0")}Z`,
    sticker: null,
    ...overrides,
  };
}

describe("PinnedStore", () => {
  it("listFor returns a stable reference until that channel's pins change", () => {
    const store = new PinnedStore();
    const emptyBefore = store.listFor(1);
    expect(emptyBefore).toEqual([]);

    store.applySnapshot(1, [message(1), message(2)]);
    const list = store.listFor(1);
    expect(list.map((entry) => entry.id)).toEqual([1, 2]);

    const listener = vi.fn();
    store.subscribe(listener);
    // an unrelated channel's snapshot must not disturb channel 1's reference
    store.applySnapshot(2, [message(9)]);
    expect(store.listFor(1)).toBe(list);
    expect(listener).toHaveBeenCalled();
  });

  it("applyFromMessage inserts a new pin keeping pinnedAt-ASC order", () => {
    const store = new PinnedStore();
    store.applySnapshot(1, [message(1), message(3)]);

    // a pin that happened BETWEEN the two stored pins lands in the middle
    const inserted = store.applyFromMessage(message(2));
    expect(inserted).toBe(true);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("applyFromMessage replaces an existing pin row and drops an unpinned one", () => {
    const store = new PinnedStore();
    store.applySnapshot(1, [message(1), message(2)]);

    const edited = message(2, { content: "edited pinned text 2" });
    expect(store.applyFromMessage(edited)).toBe(true);
    expect(store.listFor(1)[1]?.content).toBe("edited pinned text 2");

    const unpinned = message(1, { pinned: false, pinnedBy: null, pinnedAt: null });
    expect(store.applyFromMessage(unpinned)).toBe(true);
    expect(store.listFor(1).map((entry) => entry.id)).toEqual([2]);

    // unpinning something that is not pinned is a no-op
    expect(store.applyFromMessage(unpinned)).toBe(false);
  });

  it("applyFromMessage ignores channels whose pins were never fetched", () => {
    const store = new PinnedStore();
    expect(store.applyFromMessage(message(5))).toBe(false);
    expect(store.listFor(1)).toEqual([]);
  });

  it("applyFromMessage is idempotent against the WS echo after the REST answer", () => {
    const store = new PinnedStore();
    store.applySnapshot(1, [message(1)]);
    store.applyFromMessage(message(2));

    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.applyFromMessage(message(2))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("dropChannel forgets the channel and stays silent for unknown ones", () => {
    const store = new PinnedStore();
    store.applySnapshot(1, [message(1)]);

    const listener = vi.fn();
    store.subscribe(listener);
    store.dropChannel(2);
    expect(listener).not.toHaveBeenCalled();
    store.dropChannel(1);
    expect(store.listFor(1)).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });
});

describe("pinned-view", () => {
  it("defaultPinIndex points at the latest pin", () => {
    expect(defaultPinIndex(0)).toBe(0);
    expect(defaultPinIndex(1)).toBe(0);
    expect(defaultPinIndex(3)).toBe(2);
  });

  it("stepPinIndex wraps on both ends", () => {
    expect(stepPinIndex(0, -1, 3)).toBe(2);
    expect(stepPinIndex(2, 1, 3)).toBe(0);
    expect(stepPinIndex(1, 1, 3)).toBe(2);
    expect(stepPinIndex(0, 0, 0)).toBe(0);
  });

  it("pinSnippet flattens newlines, caps with an ellipsis, falls back to the file name", () => {
    expect(pinSnippet(message(1, { content: "one\ntwo  three" }))).toBe("one two  three");
    const long = "x".repeat(200);
    const trimmed = pinSnippet(message(1, { content: long }));
    expect(trimmed.length).toBe(121);
    expect(trimmed.endsWith("…")).toBe(true);
    expect(pinSnippet(message(1, {
      content: null,
      attachments: [{ fileName: "photo.png", url: "http://x", key: "att/a", thumbnailKey: null, thumbnailUrl: null, durationMillis: null, width: null, height: null, sizeBytes: null }],
    }))).toBe("photo.png");
  });
});
