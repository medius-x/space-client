import { Emitter } from "../lib/store";
import type { Message } from "../../types";

/**
 * Per-connection pinned lists, keyed by channel id, ordered pinnedAt-ASC (the
 * server's /pinned contract; the card renders the LAST element as the latest
 * pin). The snapshot IS the store (the MessageStore contract): listFor returns
 * a stable reference until THAT channel's pins change.
 *
 * Feeding: applySnapshot comes from GET /messages/pinned on channel open;
 * applyFromMessage comes DIRECTLY from the `.edited` subscription callback —
 * deliberately NOT routed through MessageStore.applyEdited, which returns
 * false for rows outside the loaded window (old pins usually are) and would
 * silently drop the update. Once a channel's pin list is loaded, every pin /
 * unpin push keeps it current without refetches.
 */
export class PinnedStore extends Emitter {
  private static readonly EMPTY: readonly Message[] = [];

  private readonly lists = new Map<number, readonly Message[]>();

  getSnapshot = (): PinnedStore => this;

  /** True once the channel's pins were fetched (empty result included) — the
   *  gate that turns on live applyFromMessage updates for the channel. */
  isLoaded(channelId: number): boolean {
    return this.lists.has(channelId);
  }

  listFor(channelId: number): readonly Message[] {
    return this.lists.get(channelId) ?? PinnedStore.EMPTY;
  }

  /** Channel ids with a fetched pin list — the reconnect heal iterates these. */
  loadedChannelIds(): number[] {
    return [...this.lists.keys()];
  }

  /** The GET /messages/pinned answer (oldest pin first, already sorted server-side). */
  applySnapshot(channelId: number, messages: readonly Message[]): void {
    this.lists.set(channelId, messages);
    this.emit();
  }

  /** A full-row push (pin/unpin REST answer or .edited echo): upsert or remove by the
   *  pinned flag, keeping the pinnedAt-ASC order. No-op for channels whose pins were
   *  never fetched (nothing rendered to update) and for rows that change nothing the
   *  card renders (the WS echo after the REST answer already applied). */
  applyFromMessage(message: Message): boolean {
    const current = this.lists.get(message.channelId);
    if (current === undefined) {
      return false;
    }
    if (!message.pinned) {
      const remaining = current.filter((entry) => entry.id !== message.id);
      if (remaining.length === current.length) {
        return false;
      }
      this.lists.set(message.channelId, remaining);
      this.emit();
      return true;
    }
    if (current.some((entry) => entry.id === message.id && samePinRow(entry, message))) {
      return false;
    }
    const withoutSelf = current.filter((entry) => entry.id !== message.id);
    const merged = [...withoutSelf, message].sort((left, right) => {
      const leftAt = left.pinnedAt ?? "";
      const rightAt = right.pinnedAt ?? "";
      return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : left.id - right.id;
    });
    this.lists.set(message.channelId, merged);
    this.emit();
    return true;
  }

  /** Channel deleted — forget its pins entirely. */
  dropChannel(channelId: number): void {
    if (this.lists.delete(channelId)) {
      this.emit();
    }
  }
}

/** Equality over exactly what the pin card renders: the pinner, the pin moment, the text
 *  and the attachment file names. Deliberately NOT the whole row — presigned attachment
 *  URLs are re-signed on every fetch, so a byte-compare would see every echo as a change. */
function samePinRow(stored: Message, incoming: Message): boolean {
  return stored.pinnedBy === incoming.pinnedBy
    && stored.pinnedAt === incoming.pinnedAt
    && stored.content === incoming.content
    && stored.attachments.length === incoming.attachments.length
    && stored.attachments.every((attachment, index) => attachment.fileName === incoming.attachments[index]?.fileName);
}
