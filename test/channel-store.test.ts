import { describe, expect, it, vi } from "vitest";
import { ChannelStore } from "../src/domain/stores/ChannelStore";
import type { Channel } from "../src/types";

function channel(id: number, name = `c${id}`, overrides: Partial<Channel> = {}): Channel {
  // position defaults to the id — the creation order (the server's pre-category order).
  return { id, name, type: "TEXT", createdAt: "2026-01-01T00:00:00Z", locked: false, parentId: null, position: id, ...overrides };
}

describe("ChannelStore", () => {
  it("applyCreated inserts sorted by (position, id) and dedups the broadcast echo", () => {
    const store = new ChannelStore();
    expect(store.applyCreated(channel(2, "two", { type: "VOICE" }))).toBe(true);
    expect(store.applyCreated(channel(1, "one"))).toBe(true);
    expect(store.applyCreated(channel(1, "one-echo"))).toBe(false); // same id → dedup

    const snapshot = store.getSnapshot();
    expect(snapshot.map((entry) => entry.id)).toEqual([1, 2]);
    expect(snapshot[0]?.name).toBe("one"); // the first write wins, the echo is dropped
  });

  it("applyCreated inserts mid-list for an explicit position (a dragged-in neighbor)", () => {
    const store = new ChannelStore();
    store.applyCreated(channel(1, "a"));
    store.applyCreated(channel(3, "c"));
    // a channel the server placed between the two (position 2, id 9 — id breaks no ties here)
    store.applyCreated(channel(9, "b", { position: 2 }));
    expect(store.getSnapshot().map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  });

  it("sameChannel is sensitive to parentId and position — a reorder refetch emits", () => {
    const store = new ChannelStore();
    store.applySnapshot([channel(1, "a"), channel(2, "b")]);
    const listener = vi.fn();
    store.subscribe(listener);

    // The server sends its OWN (position, id) order — the reordered pair.
    store.applySnapshot([channel(2, "b", { position: 0 }), channel(1, "a", { position: 1 })]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().map((entry) => entry.id)).toEqual([2, 1]);

    store.applySnapshot([channel(2, "b", { position: 0 }), channel(1, "a", { position: 1, parentId: 7 })]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()[1]?.parentId).toBe(7);
  });

  it("sameChannel is sensitive to the AFK flag — a designation refetch emits (the badge)", () => {
    // Live report: after designating the AFK channel the settings list showed no badge —
    // the refetch's afk=true was considered "unchanged" and the old row reference kept.
    const store = new ChannelStore();
    store.applySnapshot([channel(1, "lobby")]);
    const listener = vi.fn();
    store.subscribe(listener);

    store.applySnapshot([channel(1, "lobby", { afk: true })]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]?.afk).toBe(true);

    // and back off — removing the designation must emit too
    store.applySnapshot([channel(1, "lobby")]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()[0]?.afk).toBeUndefined();
  });

  it("applyDeleted removes and reports honestly", () => {
    const store = new ChannelStore();
    store.applyCreated(channel(1));
    expect(store.applyDeleted(1)).toBe(true);
    expect(store.applyDeleted(1)).toBe(false);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("applySnapshot REUSES references of unchanged rows — no emit for an identical refetch", () => {
    const store = new ChannelStore();
    store.applySnapshot([channel(1), channel(2)]);
    const first = store.getSnapshot();

    const listener = vi.fn();
    store.subscribe(listener);

    store.applySnapshot([channel(1), channel(2)]); // fresh objects, same content
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().every((entry, index) => entry === first[index])).toBe(true);

    store.applySnapshot([channel(1), channel(2, "renamed")]); // a rename ping refetch
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[1]?.name).toBe("renamed");
    expect(store.getSnapshot()[0] === first[0]).toBe(true); // untouched row keeps its ref
  });

  it("applyUpdated replaces one row in place (rename response with per-viewer locked)", () => {
    const store = new ChannelStore();
    store.applySnapshot([channel(1), channel(2)]);
    store.applyUpdated(channel(2, "new-name", { locked: true }));
    const snapshot = store.getSnapshot();
    expect(snapshot[1]?.name).toBe("new-name");
    expect(snapshot[1]?.locked).toBe(true);
    expect(snapshot[0]?.name).toBe("c1");

    // unknown id degrades to insert
    store.applyUpdated(channel(3, "fresh", { type: "VOICE" }));
    expect(store.getSnapshot().map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("applySnapshot reflects removals (a channel hidden by new overrides)", () => {
    const store = new ChannelStore();
    store.applySnapshot([channel(1), channel(2)]);
    store.applySnapshot([channel(1)]);
    expect(store.getSnapshot().map((entry) => entry.id)).toEqual([1]);
  });
});
