import type { ChannelReadState, DmChannel, Relationship } from "../../types";
import { dmDisplayName } from "./dm-display";

/** Newest-first for ISO timestamps, with never-messaged (null) rows last.
 *  Equal values return 0 — the callers' deterministic ladders take over. */
function compareRecencyDesc(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right.localeCompare(left);
}

/**
 * Pure helpers for the oak-style CROSS-INSTANCE aggregation of friends and DMs
 * (oak's rebuildFriendsContent/rebuildDmList merge): the ACTIVE session's social
 * store unions with REST snapshots of every other saved record. DM ids and user
 * ids are unique only per instance, so every row carries its recordId; the same
 * username on two instances is two different people (no dedup — oak parity).
 */

/** One non-active record's social snapshot (REST-fetched, no live session). */
export interface BackgroundSocialSnapshot {
  recordId: string;
  /** The display name of that instance (cachedServerName ?? hostUrl). */
  serverName: string;
  /** The record's own username — dm-display's "self" for that instance. */
  selfUsername: string;
  /** The instance's icon (server profile avatar), when it has one. */
  serverAvatar: { key: string; url: string | null } | null;
  relationships: readonly Relationship[];
  dms: readonly DmChannel[];
  onlineUsernames: ReadonlySet<string>;
  /** dmId → unread/mention counts (seeded from that instance's read-states). */
  dmCounts: ReadonlyMap<number, { unread: number; mention: number }>;
  /** The instance's SERVER-channel unread/mention totals (the rail badge). */
  serverCounts: { unread: number; mention: number };
}

export interface FriendRowModel {
  recordId: string;
  serverName: string;
  serverAvatar: { key: string; url: string | null } | null;
  /** True for rows of the ACTIVE instance (full row actions). */
  active: boolean;
  relationship: Relationship;
  online: boolean;
}

/** The union of all instances' relationships, globally sorted by username. */
export function mergeFriendRows(active: {
  recordId: string;
  serverName: string;
  serverAvatar: { key: string; url: string | null } | null;
  relationships: readonly Relationship[];
  onlineUsernames: ReadonlySet<string>;
}, background: readonly BackgroundSocialSnapshot[]): FriendRowModel[] {
  const rows: FriendRowModel[] = active.relationships.map((relationship) => ({
    recordId: active.recordId,
    serverName: active.serverName,
    serverAvatar: active.serverAvatar,
    active: true,
    relationship,
    online: active.onlineUsernames.has(relationship.username),
  }));
  for (const snapshot of background) {
    for (const relationship of snapshot.relationships) {
      rows.push({
        recordId: snapshot.recordId,
        serverName: snapshot.serverName,
        serverAvatar: snapshot.serverAvatar,
        active: false,
        relationship,
        online: snapshot.onlineUsernames.has(relationship.username),
      });
    }
  }
  rows.sort((left, right) => {
    const byUsername = left.relationship.username.localeCompare(right.relationship.username);
    if (byUsername !== 0) {
      return byUsername;
    }
    // The same username on two instances is two people (oak) — break the tie
    // DETERMINISTICALLY, not by input order: the input order depends on which
    // record is ACTIVE (its rows enter first), so ties used to reshuffle on
    // every instance switch (live report, see mergeDmRows).
    const byRecord = left.recordId.localeCompare(right.recordId);
    if (byRecord !== 0) {
      return byRecord;
    }
    return left.relationship.userId - right.relationship.userId;
  });
  return rows;
}

export interface DmRowModel {
  recordId: string;
  serverName: string;
  serverAvatar: { key: string; url: string | null } | null;
  selfUsername: string;
  active: boolean;
  dm: DmChannel;
  unread: number;
  mention: number;
}

/** The union of all instances' DMs, globally sorted by recency (newest first,
 *  nulls last — oak's Comparator); equal-recency rows fall through to a
 *  deterministic name → server → recordId → dm-id ladder (render-stable). */
export function mergeDmRows(active: {
  recordId: string;
  serverName: string;
  serverAvatar: { key: string; url: string | null } | null;
  selfUsername: string;
  dms: readonly DmChannel[];
  unreadOf: (dm: DmChannel) => { unread: number; mention: number };
}, background: readonly BackgroundSocialSnapshot[]): DmRowModel[] {
  const rows: DmRowModel[] = active.dms.map((dm) => ({
    recordId: active.recordId,
    serverName: active.serverName,
    serverAvatar: active.serverAvatar,
    selfUsername: active.selfUsername,
    active: true,
    dm,
    ...active.unreadOf(dm),
  }));
  for (const snapshot of background) {
    for (const dm of snapshot.dms) {
      rows.push({
        recordId: snapshot.recordId,
        serverName: snapshot.serverName,
        serverAvatar: snapshot.serverAvatar,
        selfUsername: snapshot.selfUsername,
        active: false,
        dm,
        ...(snapshot.dmCounts.get(dm.id) ?? { unread: 0, mention: 0 }),
      });
    }
  }
  rows.sort((left, right) => {
    const byRecency = compareRecencyDesc(left.dm.lastMessageAt, right.dm.lastMessageAt);
    if (byRecency !== 0) {
      return byRecency;
    }
    // Equal recency (same timestamp, or several never-messaged rows): a
    // DETERMINISTIC ladder. The old sort left ties in input order — which
    // depends on WHICH record is active (its rows enter first, snapshots
    // after) — so switching DMs reshuffled the equal rows every promote
    // (live report 2026-09-24). Name → server → recordId → dm id is a total
    // order: the list renders identically every time, whatever the mix.
    const byName = dmDisplayName(left.dm, left.selfUsername)
      .localeCompare(dmDisplayName(right.dm, right.selfUsername));
    if (byName !== 0) {
      return byName;
    }
    const byServer = left.serverName.localeCompare(right.serverName);
    if (byServer !== 0) {
      return byServer;
    }
    const byRecord = left.recordId.localeCompare(right.recordId);
    if (byRecord !== 0) {
      return byRecord;
    }
    return right.dm.id - left.dm.id;
  });
  return rows;
}

/** Seed counts for one background record: its read-states filtered to DM rows
 *  (the server computes the counters; non-DM channels are not our business). */
export function backgroundDmCounts(readStates: readonly ChannelReadState[], dmIds: ReadonlySet<number>): Map<number, { unread: number; mention: number }> {
  const counts = new Map<number, { unread: number; mention: number }>();
  for (const state of readStates) {
    if (dmIds.has(state.channelId)) {
      counts.set(state.channelId, { unread: state.unreadCount, mention: state.mentionCount });
    }
  }
  return counts;
}

/** The same read-states' SERVER-channel totals — the rail badge of an inactive
 *  instance (grey = unread, red = mentioned; oak's unreadSummaryByConnection). */
export function backgroundServerCounts(readStates: readonly ChannelReadState[], dmIds: ReadonlySet<number>): { unread: number; mention: number } {
  let unread = 0;
  let mention = 0;
  for (const state of readStates) {
    if (!dmIds.has(state.channelId)) {
      unread += state.unreadCount;
      mention += state.mentionCount;
    }
  }
  return { unread, mention };
}
