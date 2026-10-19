import { Emitter } from "../lib/store";
import { patchReplyTreesForDeleted, patchReplyTreesForEdited } from "../logic/reply-tree";
import type { Message, ReactionSummary } from "../../types";

/**
 * The newest SERVER row of a list, skipping local temp rows (negative ids —
 * the optimistic send parks its in-flight/failed rows at the list's end). Null
 * when the list holds nothing server-side. Every "the last id" consumer (ack,
 * NEW-divider tail, downward pagination, the around guard) means a SERVER id:
 * a temp id must never travel into a request or a comparison against history.
 */
export function lastServerMessageId(messages: readonly Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.id >= 0) {
      return message.id;
    }
  }
  return null;
}

/** Sort rank: server rows by id ascending, local temp rows (negative id) AFTER
 *  every server row in insertion order — the optimistic tail. */
function messageOrderKey(message: Message): number {
  return message.id < 0 ? Number.MAX_SAFE_INTEGER : message.id;
}

/**
 * Per-connection message lists, keyed by channel id. The snapshot IS the store
 * (a stable reference); selectors call listFor(channelId), which returns the same
 * array reference until THAT channel's list changes — the useSyncExternalStore
 * contract that keeps unrelated channels from re-rendering each other.
 *
 * Ordering: server pages arrive OLDEST FIRST; live messages insert by id (ids
 * ascend per channel, so a binary-search insert doubles as the echo-dedup).
 * Local OPTIMISTIC temp rows (negative ids) live after the newest server row.
 */
export class MessageStore extends Emitter {
  private static readonly EMPTY: readonly Message[] = [];

  private readonly lists = new Map<number, readonly Message[]>();
  private readonly loadedChannels = new Set<number>();
  /** Channels loaded as an AROUND WINDOW in the middle of history (the search-result jump):
   *  an id-unknown gap sits between the window's last id and the channel's live tail. Live
   *  appends below the window are FORBIDDEN (they would pretend the list is contiguous) —
   *  the tail is reached by paginating down or "Jump to present", which clears the flag. */
  private readonly aroundWithoutTail = new Set<number>();
  /** Per-channel count of live messages DROPPED by the around guard — the "gap
   *  below the window is alive" signal. Feeds the Jump-to-present pill's "N new"
   *  label and the session's auto catch-up trigger; reset whenever the flag is
   *  cleared or a fresh window replaces the list. */
  private readonly aroundDropCounts = new Map<number, number>();
  /** Temp-row id source — counts down from -1; server ids are positive, so the
   *  spaces can never collide. */
  private nextLocalMessageId = -1;

  getSnapshot = (): MessageStore => this;

  listFor(channelId: number): readonly Message[] {
    return this.lists.get(channelId) ?? MessageStore.EMPTY;
  }

  isLoaded(channelId: number): boolean {
    return this.loadedChannels.has(channelId);
  }

  isAroundWithoutTail(channelId: number): boolean {
    return this.aroundWithoutTail.has(channelId);
  }

  /** Live messages the around guard has dropped for this channel since the flag
   *  was (re)armed — "how much life is flowing below the window". */
  aroundDropCount(channelId: number): number {
    return this.aroundDropCounts.get(channelId) ?? 0;
  }

  /** Initial history load. Idempotent by caller convention (guarded by isLoaded). Clears any
   *  around-window state — a plain snapshot IS the contiguous tail by definition. Local temp
   *  rows SURVIVE the replace (minus any whose server copy arrived inside the snapshot):
   *  an in-flight POST still needs its row for resolve, a failed row is the only place the
   *  text still exists — losing either would eat the user's words. */
  applySnapshot(channelId: number, messages: readonly Message[]): void {
    this.lists.set(channelId, this.withSurvivingTempRows(channelId, messages));
    this.loadedChannels.add(channelId);
    this.aroundWithoutTail.delete(channelId);
    this.aroundDropCounts.delete(channelId);
    this.emit();
  }

  /** Around-window load (the search jump): REPLACES the channel's list (a jump away from the
   *  tail discards it — "Jump to present" refetches the tail with applySnapshot). Marks the
   *  channel around-without-tail: live appends past the window are dropped until the gap is
   *  paginated through and {@link markTailReached} fires. */
  applySnapshotAround(channelId: number, messages: readonly Message[]): void {
    // Temp rows survive a window replace too (same reasoning as applySnapshot).
    this.lists.set(channelId, this.withSurvivingTempRows(channelId, messages));
    this.loadedChannels.add(channelId);
    this.aroundWithoutTail.add(channelId);
    this.aroundDropCounts.delete(channelId); // a fresh window restarts the count
    this.emit();
  }

  /** The around window's gap has been paginated through: the list is contiguous with the live
   *  tail again, so live appends (and the reconnect heal) are legal from here on. */
  markTailReached(channelId: number): void {
    const wasAround = this.aroundWithoutTail.delete(channelId);
    const hadDrops = this.aroundDropCounts.delete(channelId);
    if (wasAround || hadDrops) {
      this.emit();
    }
  }

  /**
   * A member's LOGIN changed (the removal tombstone — the live author FK now resolves
   * under a new username). Already-loaded messages still carry the OLD authorUsername,
   * which no longer matches any roster row (the renderer would fall back to the bare
   * old login). Repoints every loaded message of that author by the stable authorId,
   * so the author renders through the live roster under the new name. A no-op when no
   * loaded message belongs to the member.
   */
  renameAuthor(userId: number, nextUsername: string): void {
    let changed = false;
    for (const [channelId, list] of this.lists) {
      const next = list.map((message) =>
        message.authorId === userId && message.authorUsername !== nextUsername
          ? { ...message, authorUsername: nextUsername }
          : message);
      if (next !== list) {
        this.lists.set(channelId, next);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /**
   * A live message (STOMP push or the sender's own REST echo — both carry the same
   * id, the sender just gets them first). Dropped for channels whose history has
   * not been loaded yet: opening the channel refetches a page that includes them.
   * A SELF live row whose optimistic temp still sits in the tail ABSORBS it (the
   * echo-vs-201 race — whichever arrives first eats the temp row). Returns true
   * when the list changed.
   */
  applyLive(message: Message): boolean {
    if (!this.loadedChannels.has(message.channelId)) {
      return false;
    }
    const current = this.lists.get(message.channelId) ?? MessageStore.EMPTY;
    // Around window: a message NEWER than the window's last SERVER id lives in the
    // unloaded gap (or the tail) — inserting it would stitch a hole into the
    // "contiguous" list. Messages landing INSIDE the window (echoes, rare same-id
    // races) insert as usual. (A temp row must not widen the guard: its negative
    // id would classify every server row as "newer".)
    const tailServerId = lastServerMessageId(current);
    if (this.aroundWithoutTail.has(message.channelId) && tailServerId !== null
        && message.id > tailServerId) {
      // Count the drop: the pill shows "N new" and the session's auto catch-up
      // keys on this signal (the gap below the window is demonstrably alive).
      this.aroundDropCounts.set(message.channelId, (this.aroundDropCounts.get(message.channelId) ?? 0) + 1);
      this.emit();
      return false;
    }
    let insertionIndex = current.length;
    while (insertionIndex > 0) {
      const neighbor = current[insertionIndex - 1];
      if (neighbor === undefined || neighbor.id <= message.id) {
        break;
      }
      insertionIndex -= 1;
    }
    const before = current[insertionIndex - 1];
    if (before !== undefined && before.id === message.id) {
      return false; // echo of something already stored
    }
    const after = current[insertionIndex];
    if (after !== undefined && after.id === message.id) {
      return false;
    }
    // Absorb FIRST, insert second: the temp's server copy may be this very row
    // (the echo won the race against the 201), and the dedup above already
    // proved this id is new to the list.
    const absorbed = this.absorbMatchingTempRow(message.channelId, message);
    const survivors = absorbed !== null ? absorbed : current;
    this.lists.set(message.channelId, [
      ...survivors.slice(0, insertionIndex),
      message,
      ...survivors.slice(insertionIndex),
    ]);
    this.emit();
    return true;
  }

  /**
   * Prepend an older page (back-fill). Overlap with the current oldest is normal —
   * the returned count is what the caller anchors its scroll on (VirtualList, M2).
   */
  prependPage(channelId: number, page: readonly Message[]): number {
    const current = this.lists.get(channelId);
    if (current === undefined || page.length === 0) {
      return 0;
    }
    const existingIds = new Set(current.map((message) => message.id));
    const fresh = page.filter((message) => !existingIds.has(message.id));
    if (fresh.length === 0) {
      return 0;
    }
    this.lists.set(channelId, [...fresh, ...current]);
    this.emit();
    return fresh.length;
  }

  /** Channel ids with a loaded history — the reconnect gap heal iterates these. */
  loadedChannelIds(): number[] {
    return [...this.loadedChannels];
  }

  /**
   * Append a newer page (the around window's downward pagination). Mirror of
   * {@link prependPage}: dedup by id, sorted concat keeps the id-ascending
   * invariant, the return value is the count of messages actually added (the
   * caller keys its "tail reached" latch on the RAW page length, not this).
   */
  appendPage(channelId: number, page: readonly Message[]): number {
    const current = this.lists.get(channelId);
    if (current === undefined || page.length === 0) {
      return 0;
    }
    const existingIds = new Set(current.map((message) => message.id));
    const fresh = page.filter((message) => !existingIds.has(message.id));
    if (fresh.length === 0) {
      return 0;
    }
    this.lists.set(channelId, [...current, ...fresh].sort((left, right) => messageOrderKey(left) - messageOrderKey(right)));
    this.emit();
    return fresh.length;
  }

  /**
   * Merge a refetched NEWEST page into a loaded channel (the STOMP-reconnect
   * gap heal). Insert-only by id in one batched emit — the same invariant
   * applyLive keeps, without N emits for N messages. Returns the messages that
   * were actually NEW: the caller fires the live accounting (unread/mention/
   * preview) for them, because they were missed while the socket was down.
   * Self rows absorb their optimistic temp tail here too — the heal can deliver
   * the server copy the sender missed while disconnected.
   */
  mergeTail(channelId: number, page: readonly Message[]): Message[] {
    if (!this.loadedChannels.has(channelId) || page.length === 0) {
      return [];
    }
    // An around window has an id-unknown GAP below it — a sorted concat would stitch the
    // window and the tail into one "contiguous" list over the hole. The heal skips the
    // channel (read-state resync restores its counters); "Jump to present" refetches the tail.
    if (this.aroundWithoutTail.has(channelId)) {
      return [];
    }
    const current = this.lists.get(channelId) ?? MessageStore.EMPTY;
    const existingIds = new Set(current.map((message) => message.id));
    const fresh = page.filter((message) => !existingIds.has(message.id));
    if (fresh.length === 0) {
      return [];
    }
    let merged = current;
    for (const message of fresh) {
      const absorbed = this.absorbMatchingTempRow(channelId, message, merged);
      if (absorbed !== null) {
        merged = absorbed;
      }
    }
    // The list is kept id-ascending (applyLive's invariant), temp rows parked
    // after the server tail — the order-key sort keeps both.
    this.lists.set(channelId, [...merged, ...fresh].sort((left, right) => messageOrderKey(left) - messageOrderKey(right)));
    this.emit();
    return fresh;
  }

  /**
   * The .edited push: replace the row by id AND refresh every quote tree that
   * references it. Idempotent against the REST caller's own optimistic replace.
   */
  applyEdited(edited: Message): boolean {
    const current = this.lists.get(edited.channelId);
    if (current === undefined || !current.some((message) => message.id === edited.id)) {
      return false;
    }
    const replaced = current.map((message) => (message.id === edited.id ? edited : message));
    this.lists.set(edited.channelId, patchReplyTreesForEdited(replaced, edited));
    this.emit();
    return true;
  }

  /** The .deleted push (bare id): remove the row, mark its quote levels deleted. */
  applyDeleted(channelId: number, messageId: number): boolean {
    const current = this.lists.get(channelId);
    if (current === undefined || !current.some((message) => message.id === messageId)) {
      return false;
    }
    const remaining = current.filter((message) => message.id !== messageId);
    this.lists.set(channelId, patchReplyTreesForDeleted(remaining, messageId));
    this.emit();
    return true;
  }

  /** The .reactions push — the full snapshot replaces the chip row wholesale. */
  applyReactions(channelId: number, messageId: number, reactions: ReactionSummary[]): boolean {
    const current = this.lists.get(channelId);
    if (current === undefined) {
      return false;
    }
    const target = current.find((message) => message.id === messageId);
    if (target === undefined || target.reactions === reactions) {
      return false;
    }
    this.lists.set(channelId, current.map((message) => (message.id === messageId ? { ...message, reactions } : message)));
    this.emit();
    return true;
  }

  /** Channel deleted — forget its list entirely. */
  dropChannel(channelId: number): void {
    const hadList = this.lists.delete(channelId);
    const wasLoaded = this.loadedChannels.delete(channelId);
    const wasAround = this.aroundWithoutTail.delete(channelId);
    const hadDrops = this.aroundDropCounts.delete(channelId);
    if (hadList || wasLoaded || wasAround || hadDrops) {
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------
  // Optimistic send (user decision 2026-10-15, Discord-style): a TEXT send gets
  // a local temp row (negative id) parked after the server tail the moment the
  // composer submits; the POST resolves/fails against that row later.
  // ---------------------------------------------------------------------------

  /** Park the just-submitted text as a pending temp row at the list's tail and
   *  return it (the session keeps its id + idempotency key for resolve/retry). */
  appendPending(channelId: number, draft: {
    content: string;
    authorId: number;
    authorUsername: string;
    replyToId: number | null;
    idempotencyKey: string;
  }): Message {
    const temp: Message = {
      id: this.nextLocalMessageId,
      channelId,
      authorId: draft.authorId,
      authorUsername: draft.authorUsername,
      content: draft.content,
      createdAt: new Date().toISOString(),
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
      delivery: "pending",
      idempotencyKey: draft.idempotencyKey,
      replyToId: draft.replyToId,
    };
    this.nextLocalMessageId -= 1;
    const current = this.lists.get(channelId) ?? MessageStore.EMPTY;
    this.lists.set(channelId, [...current, temp]);
    this.emit();
    return temp;
  }

  /** The server's 201 (or a retry's answer): retire the temp row — if it is
   *  still around; the STOMP echo may have absorbed it already — and insert the
   *  real row through the normal id-dedup path. Returns true when the list changed. */
  resolvePending(channelId: number, tempId: number, created: Message): boolean {
    const current = this.lists.get(channelId);
    let removedTemp = false;
    if (current !== undefined && current.some((message) => message.id === tempId)) {
      this.lists.set(channelId, current.filter((message) => message.id !== tempId));
      removedTemp = true;
    }
    const inserted = this.applyLive(created);
    return removedTemp || inserted;
  }

  /** A temp row by id (the retry's source of truth) — null when it is gone. */
  pendingMessageById(channelId: number, tempId: number): Message | null {
    const found = this.lists.get(channelId)?.find((message) => message.id === tempId);
    return found !== undefined && found.id < 0 ? found : null;
  }

  /** Flip a temp row's delivery marker (failed on send failure, back to pending
   *  on retry). Server rows (positive ids) are never eligible. */
  markPendingDelivery(channelId: number, tempId: number, delivery: "pending" | "failed"): boolean {
    const current = this.lists.get(channelId);
    if (current === undefined || !current.some((message) => message.id === tempId && message.id < 0)) {
      return false;
    }
    this.lists.set(channelId, current.map((message) =>
      message.id === tempId ? { ...message, delivery } : message));
    this.emit();
    return true;
  }

  /** Remove a temp row (the failed row's "Remove" action). Server rows ineligible. */
  removePendingMessage(channelId: number, tempId: number): boolean {
    const current = this.lists.get(channelId);
    if (current === undefined || tempId >= 0 || !current.some((message) => message.id === tempId)) {
      return false;
    }
    this.lists.set(channelId, current.filter((message) => message.id !== tempId));
    this.emit();
    return true;
  }

  /** Drop the FIRST temp row matching a server row's (authorId, content) — the
   *  server copy replaces its own optimistic draft (FIFO keeps duplicate texts
   *  straight: two "ok" temps, two echoes, each eats one). Returns the shortened
   *  list, or null when nothing matched. Pure over `listOverride`/the store. */
  private absorbMatchingTempRow(channelId: number, incoming: Message, listOverride?: readonly Message[]): readonly Message[] | null {
    const current = listOverride ?? this.lists.get(channelId);
    if (current === undefined) {
      return null;
    }
    const matchIndex = current.findIndex((candidate) =>
      candidate.id < 0
      && candidate.authorId === incoming.authorId
      && candidate.content === incoming.content);
    if (matchIndex < 0) {
      return null;
    }
    return [...current.slice(0, matchIndex), ...current.slice(matchIndex + 1)];
  }

  /** The snapshot replace's temp policy: keep every temp row whose server copy
   *  did NOT arrive inside the snapshot (in-flight POSTs resolve later; a failed
   *  row is the only place its text still exists). */
  private withSurvivingTempRows(channelId: number, messages: readonly Message[]): readonly Message[] {
    const current = this.lists.get(channelId);
    const tempRows = current?.filter((message) => message.id < 0) ?? [];
    if (tempRows.length === 0) {
      return messages;
    }
    const survivors: Message[] = [];
    let remaining: readonly Message[] = tempRows;
    for (const serverRow of messages) {
      const absorbed = this.absorbMatchingTempRow(channelId, serverRow, remaining);
      if (absorbed !== null) {
        remaining = absorbed;
      }
    }
    survivors.push(...remaining);
    return survivors.length > 0 ? [...messages, ...survivors] : messages;
  }
}
