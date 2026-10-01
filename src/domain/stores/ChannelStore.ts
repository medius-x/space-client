import { Emitter } from "../lib/store";
import type { Channel } from "../../types";

/**
 * Per-connection channel list. Live mutations from the STOMP topics land here:
 *   /topic/channels          → applyCreated (dedup by id — the creator's optimistic
 *                              REST insert eats the broadcast echo)
 *   /topic/channels.deleted  → applyDeleted (bare id)
 *   /topic/channels.changed  → ping → the session diff-refetches → applySnapshot
 *
 * applySnapshot reuses the OLD object reference for unchanged rows so unrelated
 * refetches (a rename ping from someone else's override edit) do not invalidate
 * consumers of untouched channels.
 */
function sameChannel(left: Channel, right: Channel): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.createdAt === right.createdAt
    && left.locked === right.locked
    && left.parentId === right.parentId
    && left.position === right.position
    && left.afk === right.afk;
}

export class ChannelStore extends Emitter {
  private channels: readonly Channel[] = [];

  getSnapshot = (): readonly Channel[] => this.channels;

  get(channelId: number): Channel | null {
    return this.channels.find((channel) => channel.id === channelId) ?? null;
  }

  /** Diff-preserving replace: the incoming order (the server's manual sidebar
   *  order — (position, id)) wins. */
  applySnapshot(incoming: readonly Channel[]): void {
    const byId = new Map(this.channels.map((channel) => [channel.id, channel]));
    const merged = incoming.map((channel) => {
      const existing = byId.get(channel.id);
      return existing !== undefined && sameChannel(existing, channel) ? existing : channel;
    });
    if (merged.length !== this.channels.length || merged.some((channel, index) => channel !== this.channels[index])) {
      this.channels = merged;
      this.emit();
    }
  }

  /** Returns true when actually inserted (false = duplicate id). Inserts keeping
   *  the (position, id) order — a creation appends at the server's max+1, so the
   *  insert index is normally the end. */
  applyCreated(channel: Channel): boolean {
    if (this.channels.some((existing) => existing.id === channel.id)) {
      return false;
    }
    const insertIndex = this.channels.findIndex((existing) =>
      existing.position > channel.position
      || (existing.position === channel.position && existing.id > channel.id));
    this.channels = insertIndex === -1
      ? [...this.channels, channel]
      : [...this.channels.slice(0, insertIndex), channel, ...this.channels.slice(insertIndex)];
    this.emit();
    return true;
  }

  /** Replace one row in place (rename REST response carries per-viewer `locked`). */
  applyUpdated(channel: Channel): void {
    if (!this.channels.some((existing) => existing.id === channel.id)) {
      this.applyCreated(channel);
      return;
    }
    this.channels = this.channels.map((existing) => (existing.id === channel.id ? channel : existing));
    this.emit();
  }

  /** Returns true when actually removed. */
  applyDeleted(channelId: number): boolean {
    const next = this.channels.filter((channel) => channel.id !== channelId);
    if (next.length === this.channels.length) {
      return false;
    }
    this.channels = next;
    this.emit();
    return true;
  }
}
