import { Emitter } from "../lib/store";
import type { Discussion, DiscussionEvent } from "../../types";

/**
 * Per-connection discussion state. Three lookups over one source of truth:
 * `byOrigin` (origin message id → discussion — renders the tile under a chat row and answers
 * "does this message have a thread"), `byId` (discussion channel id → discussion — the open
 * view, tracking), and `mine` (the tracked list for the sidebar; entries are SHARED row
 * objects with the maps — tracked flips mutate one row and every view sees it).
 *
 * Feeding: channel-scoped snapshots (fetchChannelDiscussions), the mine snapshot, and the
 * parent's `.discussions` topic events (CREATED/ACTIVITY upsert, REMOVED purge everywhere).
 * Snapshots are cached arrays replaced wholesale — getSnapshot returns stable references
 * until a real mutation (the useSyncExternalStore contract; derived arrays live in the
 * components' useMemo, never here).
 */
export class DiscussionsStore extends Emitter {
  private byOriginMap = new Map<number, Discussion>();
  private byIdMap = new Map<number, Discussion>();
  private mineSnapshot: readonly Discussion[] = [];
  private versionCounter = 0;

  getSnapshot = (): DiscussionsStore => this;

  /** Bumped on EVERY mutation — the useStore selector key for components that read the
   *  store imperatively (byOrigin lookups inside render): the store object itself is a
   *  stable singleton, so a selector must return THIS to re-render. */
  get version(): number {
    return this.versionCounter;
  }

  protected override emit(): void {
    this.versionCounter += 1;
    super.emit();
  }

  byOrigin(originMessageId: number): Discussion | undefined {
    return this.byOriginMap.get(originMessageId);
  }

  byId(discussionId: number): Discussion | undefined {
    return this.byIdMap.get(discussionId);
  }

  mine(): readonly Discussion[] {
    return this.mineSnapshot;
  }

  /** The tracked discussions of ONE parent channel — the sidebar's per-channel badge counts. */
  mineForParent(parentChannelId: number): readonly Discussion[] {
    return this.mineSnapshot.filter((discussion) => discussion.parentChannelId === parentChannelId
      && discussion.tracked);
  }

  /** Every KNOWN discussion of one parent channel (tracked or not — the optimistic merge after
   *  starting one). Derived on demand: callers wrap it in their own useMemo. */
  forParent(parentChannelId: number): Discussion[] {
    const rows: Discussion[] = [];
    for (const discussion of this.byIdMap.values()) {
      if (discussion.parentChannelId === parentChannelId) {
        rows.push(discussion);
      }
    }
    return rows;
  }

  /** True when the channel id is a discussion channel we know of — the guard that keeps the
   *  reconnect tail-heal and the read-state accounting from touching threads. */
  isDiscussionChannel(channelId: number): boolean {
    return this.byIdMap.has(channelId);
  }

  /** GET /api/channels/{id}/discussions — replaces everything known about that channel's
   *  threads (the mine rows for the same discussions are re-pointed at the fresh objects). */
  applyParentSnapshot(parentChannelId: number, discussions: readonly Discussion[]): void {
    for (const known of this.byOriginMap.values()) {
      if (known.parentChannelId === parentChannelId) {
        this.byOriginMap.delete(known.originMessageId);
        this.byIdMap.delete(known.id);
      }
    }
    this.upsertAll(discussions);
    this.rebuildMine();
  }

  /** GET /api/discussions/mine — the tracked list, ordered most-recently-active first by the
   *  server. Rows are merged into the maps (a fresher replyCount wins). */
  applyMineSnapshot(discussions: readonly Discussion[]): void {
    this.mineSnapshot = discussions;
    this.upsertAll(discussions);
    this.emit();
  }

  /** The `.discussions` topic event. CREATED/ACTIVITY carry the FULL row and upsert it
   *  directly (a peer that never fetched the channel's list still renders the tile from the
   *  push); the LOCAL tracked flag wins over the broadcast one (tracking is viewer-scoped —
   *  the server broadcasts false for everyone). REMOVED purges everywhere. */
  applyEvent(event: DiscussionEvent): void {
    if (event.type === "REMOVED") {
      const existing = this.byIdMap.get(event.discussionId);
      if (existing !== undefined) {
        this.byOriginMap.delete(existing.originMessageId);
      }
      this.byIdMap.delete(event.discussionId);
      this.mineSnapshot = this.mineSnapshot.filter((discussion) => discussion.id !== event.discussionId);
      this.emit();
      return;
    }
    if (event.discussion === null) {
      return; // a shape we cannot render without the row — ignore
    }
    const known = this.byIdMap.get(event.discussion.id);
    this.upsertAll([known !== undefined ? { ...event.discussion, tracked: known.tracked } : event.discussion]);
  }

  /** Optimistic tracked flip (track/untrack REST answer) — rewrites the SHARED row and
   *  re-derives the mine list (untracking removes it; tracking keeps server order). */
  setTracked(discussionId: number, tracked: boolean): void {
    const known = this.byIdMap.get(discussionId);
    if (known === undefined || known.tracked === tracked) {
      return;
    }
    const updated = { ...known, tracked };
    this.upsertAll([updated]);
    this.rebuildMine();
  }

  /** Parent channel gone — drop its discussions (their channels' message lists are dropped
   *  separately by the session's forgetChannel loop). */
  dropParent(parentChannelId: number): void {
    const removedIds = new Set<number>();
    for (const known of this.byOriginMap.values()) {
      if (known.parentChannelId === parentChannelId) {
        removedIds.add(known.id);
        this.byOriginMap.delete(known.originMessageId);
      }
    }
    if (removedIds.size === 0) {
      return;
    }
    for (const discussionId of removedIds) {
      this.byIdMap.delete(discussionId);
    }
    this.mineSnapshot = this.mineSnapshot.filter((discussion) => !removedIds.has(discussion.id));
    this.emit();
  }

  /** The local half of a close (the REMOVED echo is idempotent on top). */
  dropDiscussion(discussionId: number): void {
    const existing = this.byIdMap.get(discussionId);
    if (existing === undefined) {
      return;
    }
    this.byOriginMap.delete(existing.originMessageId);
    this.byIdMap.delete(discussionId);
    this.mineSnapshot = this.mineSnapshot.filter((discussion) => discussion.id !== discussionId);
    this.emit();
  }

  private upsertAll(discussions: readonly Discussion[]): void {
    for (const discussion of discussions) {
      this.byOriginMap.set(discussion.originMessageId, discussion);
      this.byIdMap.set(discussion.id, discussion);
    }
    if (discussions.length > 0) {
      // A fresher row (ACTIVITY event, mine merge) must reach the MINE list too — its rows
      // are shared with the maps, not copies.
      const upserted = new Map(discussions.map((entry) => [entry.id, entry]));
      this.mineSnapshot = this.mineSnapshot.map((entry) => upserted.get(entry.id) ?? entry);
      this.emit();
    }
  }

  /** Re-derive the mine list from the tracked rows, keeping the SERVER's ordering (fresh
   *  snapshots arrive ordered by activity; locally tracked rows append at the end — ordering
   *  heals on the next snapshot/event refresh). */
  private rebuildMine(): void {
    const trackedIds = new Set(this.mineSnapshot.map((discussion) => discussion.id));
    const mine = this.mineSnapshot
      .map((discussion) => this.byIdMap.get(discussion.id) ?? discussion)
      .filter((discussion) => discussion.tracked);
    for (const discussion of this.byIdMap.values()) {
      if (discussion.tracked && !trackedIds.has(discussion.id)) {
        mine.push(discussion);
      }
    }
    this.mineSnapshot = mine;
    this.emit();
  }
}
