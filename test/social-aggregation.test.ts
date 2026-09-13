import { describe, expect, it } from "vitest";
import {
  backgroundDmCounts,
  backgroundServerCounts,
  mergeDmRows,
  mergeFriendRows,
  type BackgroundSocialSnapshot,
} from "../src/domain/logic/social-aggregation";
import type { DmChannel, Relationship } from "../src/types";

function relationship(userId: number, username: string, type: Relationship["type"] = "FRIEND"): Relationship {
  return { userId, username, type, avatarKey: null, avatarUrl: null };
}

function dm(id: number, lastMessageAt: string | null, name: string | null = null): DmChannel {
  return {
    id,
    type: name === null ? "DM" : "GROUP_DM",
    name: name ?? "",
    ownerId: null,
    participants: [],
    lastMessageId: null,
    lastMessageAt,
    lastMessagePreview: null,
    lastMessageAuthorName: null,
  };
}

function snapshot(recordId: string, overrides: Partial<BackgroundSocialSnapshot> = {}): BackgroundSocialSnapshot {
  return {
    recordId,
    serverName: `server-${recordId}`,
    selfUsername: `self-${recordId}`,
    serverAvatar: null,
    relationships: [],
    dms: [],
    onlineUsernames: new Set<string>(),
    dmCounts: new Map(),
    serverCounts: { unread: 0, mention: 0 },
    ...overrides,
  };
}

describe("mergeFriendRows (the cross-instance friends union)", () => {
  it("unions the active session with every background record, sorted by username", () => {
    const rows = mergeFriendRows(
      {
        recordId: "a",
        serverName: "Alpha",
        serverAvatar: null,
        relationships: [relationship(1, "zoe"), relationship(2, "bob")],
        onlineUsernames: new Set(["bob"]),
      },
      [snapshot("b", { relationships: [relationship(7, "anna")] })],
    );
    expect(rows.map((row) => row.relationship.username)).toEqual(["anna", "bob", "zoe"]);
    expect(rows.map((row) => row.active)).toEqual([false, true, true]);
    expect(rows.map((row) => row.online)).toEqual([false, true, false]);
    expect(rows.map((row) => row.serverName)).toEqual(["server-b", "Alpha", "Alpha"]);
  });

  it("does NOT dedup the same username across instances (oak: two different people)", () => {
    const rows = mergeFriendRows(
      { recordId: "a", serverName: "A", serverAvatar: null, relationships: [relationship(1, "bob")], onlineUsernames: new Set() },
      [snapshot("b", { relationships: [relationship(9, "bob")] })],
    );
    expect(rows).toHaveLength(2);
    // Equal usernames tie; the stable sort keeps the active row first.
    expect(rows.map((row) => row.recordId)).toEqual(["a", "b"]);
    expect(rows.map((row) => row.relationship.userId)).toEqual([1, 9]);
  });
});

describe("mergeDmRows (the cross-instance DM union)", () => {
  it("sorts globally by recency, newest first with nulls last", () => {
    const rows = mergeDmRows(
      {
        recordId: "a",
        serverName: "A",
        serverAvatar: null,
        selfUsername: "me",
        dms: [dm(1, "2026-09-12T10:00:00Z"), dm(2, null)],
        unreadOf: () => ({ unread: 0, mention: 0 }),
      },
      [snapshot("b", { dms: [dm(3, "2026-09-12T12:00:00Z")] })],
    );
    expect(rows.map((row) => row.dm.id)).toEqual([3, 1, 2]);
    expect(rows.map((row) => row.recordId)).toEqual(["b", "a", "a"]);
  });

  it("background rows carry their record's self-username and seeded counts", () => {
    const rows = mergeDmRows(
      { recordId: "a", serverName: "A", serverAvatar: null, selfUsername: "me", dms: [], unreadOf: () => ({ unread: 0, mention: 0 }) },
      [snapshot("b", {
        selfUsername: "other-me",
        dms: [dm(5, "2026-09-12T09:00:00Z")],
        dmCounts: new Map([[5, { unread: 3, mention: 3 }]]),
      })],
    );
    expect(rows[0]!.selfUsername).toBe("other-me");
    expect(rows[0]!.unread).toBe(3);
  });
});

describe("backgroundDmCounts (the read-state seed)", () => {
  it("keeps only the DM channels' counters", () => {
    const counts = backgroundDmCounts(
      [
        { channelId: 5, unreadCount: 3, mentionCount: 3, lastReadMessageId: 1, lastMessageId: 4 },
        { channelId: 99, unreadCount: 7, mentionCount: 0, lastReadMessageId: 1, lastMessageId: 8 },
      ],
      new Set([5]),
    );
    expect(counts.get(5)).toEqual({ unread: 3, mention: 3 });
    expect(counts.has(99)).toBe(false);
  });
});

describe("backgroundServerCounts (the inactive rail badge)", () => {
  it("totals every NON-DM channel (DM unread feeds the Home badge, not the server icon)", () => {
    const counts = backgroundServerCounts(
      [
        { channelId: 5, unreadCount: 3, mentionCount: 3, lastReadMessageId: 1, lastMessageId: 4 },
        { channelId: 10, unreadCount: 4, mentionCount: 1, lastReadMessageId: 1, lastMessageId: 8 },
        { channelId: 11, unreadCount: 2, mentionCount: 0, lastReadMessageId: 1, lastMessageId: 3 },
      ],
      new Set([5]),
    );
    expect(counts).toEqual({ unread: 6, mention: 1 });
  });
});
