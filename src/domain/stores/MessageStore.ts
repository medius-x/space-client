import { Emitter } from "../lib/store";
import type { Message } from "../../types";

/**
 * Per-connection message lists, keyed by channel id. The snapshot IS the store
 * (a stable reference); selectors call listFor(channelId), which returns the same
 * array reference until THAT channel's list changes — the useSyncExternalStore
 * contract that keeps unrelated channels from re-rendering each other.
 *
 * Ordering: server pages arrive OLDEST FIRST; live messages insert by id (ids
 * ascend per channel, so a binary-search insert doubles as the echo-dedup).
 */
export class MessageStore extends Emitter {
  private static readonly EMPTY: readonly Message[] = [];

  private readonly lists = new Map<number, readonly Message[]>();
  private readonly loadedChannels = new Set<number>();

  getSnapshot = (): MessageStore => this;

  listFor(channelId: number): readonly Message[] {
    return this.lists.get(channelId) ?? MessageStore.EMPTY;
  }

  isLoaded(channelId: number): boolean {
    return this.loadedChannels.has(channelId);
  }

  /** Initial history load. Idempotent by caller convention (guarded by isLoaded). */
  applySnapshot(channelId: number, messages: readonly Message[]): void {
    this.lists.set(channelId, messages);
    this.loadedChannels.add(channelId);
    this.emit();
  }

  /**
   * A live message (STOMP push or the sender's own REST echo — both carry the same
   * id, the sender just gets them first). Dropped for channels whose history has
   * not been loaded yet: opening the channel refetches a page that includes them.
   * Returns true when inserted.
   */
  applyLive(message: Message): boolean {
    if (!this.loadedChannels.has(message.channelId)) {
      return false;
    }
    const current = this.lists.get(message.channelId) ?? MessageStore.EMPTY;
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
    this.lists.set(message.channelId, [
      ...current.slice(0, insertionIndex),
      message,
      ...current.slice(insertionIndex),
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

  /** Channel deleted — forget its list entirely. */
  dropChannel(channelId: number): void {
    const hadList = this.lists.delete(channelId);
    const wasLoaded = this.loadedChannels.delete(channelId);
    if (hadList || wasLoaded) {
      this.emit();
    }
  }
}
