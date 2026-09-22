import { describe, expect, it, vi } from "vitest";
import { DiscussionsStore } from "../src/domain/stores/DiscussionsStore";
import { groupMineByChannel, sortMineByActivity, tileReplyLabel } from "../src/domain/logic/discussions-view";
import type { Discussion, DiscussionEvent } from "../src/types";

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: 77,
    parentChannelId: 7,
    originMessageId: 100,
    originSnippet: "the origin text",
    originAuthorId: 5,
    originAuthorName: "alice",
    originCreatedAt: "2026-09-22T00:00:00Z",
    createdAt: "2026-09-22T00:00:00Z",
    lastMessageAt: null,
    replyCount: 0,
    tracked: true,
    ...overrides,
  };
}

function event(type: DiscussionEvent["type"], discussionId: number, overrides: Partial<DiscussionEvent> = {}): DiscussionEvent {
  return {
    type,
    discussionId,
    parentChannelId: 7,
    originMessageId: 100,
    lastMessageAt: null,
    replyCount: 0,
    actorUsername: null,
    discussion: null,
    message: null,
    ...overrides,
  };
}

describe("DiscussionsStore", () => {
  it("indexes by origin and id from a parent snapshot and answers isDiscussionChannel", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    expect(store.byOrigin(100)?.id).toBe(77);
    expect(store.byId(77)?.originMessageId).toBe(100);
    expect(store.isDiscussionChannel(77)).toBe(true);
    expect(store.isDiscussionChannel(7)).toBe(false);
  });

  it("a parent snapshot REPLACES the channel's threads (stale rows die)", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    store.applyParentSnapshot(7, [discussion({ id: 88, originMessageId: 101 })]);
    expect(store.byOrigin(100)).toBeUndefined();
    expect(store.byId(77)).toBeUndefined();
    expect(store.byId(88)?.id).toBe(88);
  });

  it("ACTIVITY refreshes count/moment through the shared row", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    store.applyMineSnapshot([discussion()]);
    store.applyEvent(event("ACTIVITY", 77, {
      replyCount: 3,
      lastMessageAt: "2026-09-22T01:00:00Z",
      actorUsername: "bob",
      discussion: { ...discussion(), replyCount: 3, lastMessageAt: "2026-09-22T01:00:00Z", tracked: false },
    }));
    expect(store.byOrigin(100)?.replyCount).toBe(3);
    expect(store.mine()[0]?.lastMessageAt).toBe("2026-09-22T01:00:00Z");
    // the broadcast row carries tracked=false for everyone; the LOCAL flag wins
    expect(store.byId(77)?.tracked).toBe(true);
  });

  it("CREATED renders the tile from the push alone — no channel fetch needed", () => {
    // the issue-1 regression: a peer sitting in the channel never fetched the channel's
    // discussion list; the CREATED row itself must land in byOrigin/byId.
    const store = new DiscussionsStore();
    store.applyEvent(event("CREATED", 77, {
      actorUsername: "alice",
      discussion: discussion({ tracked: false }),
    }));
    expect(store.byId(77)?.id).toBe(77);
    expect(store.byOrigin(100)?.originSnippet).toBe("the origin text");
    expect(store.mine()).toEqual([]); // not mine — only the tile appeared
  });

  it("REMOVED purges every lookup and the mine list", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    store.applyMineSnapshot([discussion()]);
    store.applyEvent(event("REMOVED", 77));
    expect(store.byId(77)).toBeUndefined();
    expect(store.byOrigin(100)).toBeUndefined();
    expect(store.mine()).toEqual([]);
  });

  it("setTracked flips the shared row and rebuilds mine (untrack removes)", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    store.applyMineSnapshot([discussion()]);

    store.setTracked(77, false);
    expect(store.byId(77)?.tracked).toBe(false);
    expect(store.mine()).toEqual([]);

    store.setTracked(77, true);
    expect(store.mine().map((entry) => entry.id)).toEqual([77]);
  });

  it("dropParent forgets only that channel's discussions", () => {
    const store = new DiscussionsStore();
    store.applyParentSnapshot(7, [discussion()]);
    store.applyParentSnapshot(9, [discussion({ id: 88, originMessageId: 101, parentChannelId: 9 })]);
    store.applyMineSnapshot([discussion(), discussion({ id: 88, originMessageId: 101, parentChannelId: 9 })]);

    store.dropParent(7);
    expect(store.byId(77)).toBeUndefined();
    expect(store.byId(88)?.id).toBe(88);
    expect(store.mine().map((entry) => entry.id)).toEqual([88]);
  });

  it("emits only on real mutations", () => {
    const store = new DiscussionsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvent(event("ACTIVITY", 999)); // no row — no-op
    store.setTracked(999, true); // unknown — no-op
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("discussions-view", () => {
  const threads = [
    discussion({ id: 1, lastMessageAt: "2026-09-22T01:00:00Z" }),
    discussion({ id: 2, lastMessageAt: null }),
    discussion({ id: 3, lastMessageAt: "2026-09-22T03:00:00Z", parentChannelId: 9 }),
    discussion({ id: 4, lastMessageAt: "2026-09-22T02:00:00Z", tracked: false }),
  ];

  it("groupMineByChannel counts tracked threads per known channel", () => {
    // channel 7 holds ids 1, 2 (tracked) and 4 (untracked — excluded); 9 holds 3.
    const counts = groupMineByChannel(threads, [7, 9]);
    expect(counts.get(7)).toBe(2);
    expect(counts.get(9)).toBe(1);
    expect(counts.has(11)).toBe(false);
  });

  it("sortMineByActivity orders most-recent first with nulls last", () => {
    // the helper orders whatever it is given (the mine list is tracked rows); 4 at 02:00
    // sorts between 3 (03:00) and 1 (01:00), the replyless 2 lands last.
    const ordered = sortMineByActivity(threads);
    expect(ordered.map((entry) => entry.id)).toEqual([3, 4, 1, 2]);
  });

  it("tileReplyLabel singularizes one reply", () => {
    expect(tileReplyLabel(discussion())).toBe("Discussion");
    expect(tileReplyLabel(discussion({ replyCount: 1 }))).toBe("Discussion · 1 reply");
    expect(tileReplyLabel(discussion({ replyCount: 3 }))).toBe("Discussion · 3 replies");
  });
});
