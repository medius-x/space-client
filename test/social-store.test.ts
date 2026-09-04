import { describe, expect, it, vi } from "vitest";
import { SocialStore } from "../src/domain/stores/SocialStore";
import { CoalescingRefresher } from "../src/domain/lib/refresher";
import type { DmChannel, Message, Relationship } from "../src/types";

function relationship(userId: number, username: string, type: Relationship["type"]): Relationship {
  return { userId, username, type, avatarKey: null, avatarUrl: null };
}

function dmChannel(id: number, overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    id,
    type: "DM",
    name: "",
    ownerId: null,
    participants: [],
    lastMessageId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageAuthorName: null,
    ...overrides,
  };
}

function message(id: number, channelId: number, createdAt: string): Message {
  return {
    id,
    channelId,
    authorId: 2,
    authorUsername: "bob",
    content: `hello ${id}`,
    createdAt,
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
  };
}

describe("SocialStore", () => {
  it("keeps the DM list sorted by recency (lastMessageAt desc, nulls last, id desc tiebreak)", () => {
    const store = new SocialStore();
    store.setDms([
      dmChannel(1, { lastMessageAt: "2026-09-01T10:00:00Z" }),
      dmChannel(2, { lastMessageAt: null }),
      dmChannel(3, { lastMessageAt: "2026-09-03T10:00:00Z" }),
      dmChannel(4, { lastMessageAt: "2026-09-03T10:00:00Z" }), // same instant → higher id first
      dmChannel(5, { lastMessageAt: "2026-09-02T10:00:00Z" }),
    ]);
    expect(store.getSnapshot().dms.map((dm) => dm.id)).toEqual([4, 3, 5, 1, 2]);
  });

  it("mergeDm replaces in place and re-sorts (an opened old DM floats by its new timestamp)", () => {
    const store = new SocialStore();
    store.setDms([
      dmChannel(1, { lastMessageAt: "2026-09-01T10:00:00Z" }),
      dmChannel(2, { lastMessageAt: "2026-09-02T10:00:00Z" }),
    ]);
    store.mergeDm(dmChannel(1, { lastMessageAt: "2026-09-03T10:00:00Z", name: "x" }));
    expect(store.getSnapshot().dms.map((dm) => dm.id)).toEqual([1, 2]);
    expect(store.getSnapshot().dms[0]!.name).toBe("x");
  });

  it("updateDmLastMessage refreshes preview fields and floats the row; older edits do not", () => {
    const store = new SocialStore();
    store.setDms([
      dmChannel(1, { lastMessageId: 10, lastMessageAt: "2026-09-01T10:00:00Z", lastMessagePreview: "old" }),
      dmChannel(2, { lastMessageAt: "2026-09-02T10:00:00Z" }),
    ]);
    store.updateDmLastMessage(message(11, 1, "2026-09-04T10:00:00Z"));
    const floated = store.getSnapshot().dms[0]!;
    expect(floated.id).toBe(1);
    expect(floated.lastMessageId).toBe(11);
    expect(floated.lastMessagePreview).toBe("hello 11");
    expect(floated.lastMessageAuthorName).toBe("bob");

    // An edit of an OLDER message must not touch the preview (oak's guard).
    store.updateDmLastMessage(message(5, 1, "2026-09-04T11:00:00Z"));
    expect(store.getSnapshot().dms[0]!.lastMessageId).toBe(11);
    expect(store.getSnapshot().dms[0]!.lastMessagePreview).toBe("hello 11");

    // Unknown channel (just closed) — a no-op, never a crash.
    store.updateDmLastMessage(message(3, 99, "2026-09-04T12:00:00Z"));
    expect(store.getSnapshot().dms).toHaveLength(2);
  });

  it("applyDmClosed drops the row and ignores unknown ids", () => {
    const store = new SocialStore();
    store.setDms([dmChannel(1), dmChannel(2)]);
    store.applyDmClosed(1);
    store.applyDmClosed(99);
    expect(store.getSnapshot().dms.map((dm) => dm.id)).toEqual([2]);
  });
});

describe("CoalescingRefresher", () => {
  it("collapses a burst into sequential runs — a queued request replays after the in-flight one", async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const refresher = new CoalescingRefresher(async () => {
      runs += 1;
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    refresher.request();
    refresher.request(); // queued while the first is in flight
    refresher.request(); // still queued (one replay, not two)
    expect(runs).toBe(1);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2); // exactly one replay
  });

  it("a failing run still replays the queued request and never throws", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("network"));
    const refresher = new CoalescingRefresher(failing);
    refresher.request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing).toHaveBeenCalledTimes(1); // swallowed, no unhandled rejection
    refresher.request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
