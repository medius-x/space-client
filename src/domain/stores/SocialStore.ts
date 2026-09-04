import { Emitter } from "../lib/store";
import { shouldRefreshPreview } from "../logic/dm-display";
import type { DmChannel, Message, Relationship } from "../../types";

/**
 * Per-connection social state: the relationship list (friends/pending/blocked)
 * and the DM channel list. Both are REFRESH-FED — STOMP events trigger a refetch
 * (oak's pattern) rather than patching individual rows, so the wire payloads
 * never need local merge logic. Two exceptions carry live local updates:
 *  - a DM row's last-message fields (the incoming message is already in hand);
 *  - self-initiated leave/close (the server does NOT push to the removed member).
 *
 * Snapshot contract: getSnapshot returns the SAME object until a mutation runs.
 */
export interface SocialState {
  relationships: readonly Relationship[];
  dms: readonly DmChannel[];
}

export class SocialStore extends Emitter {
  private state: SocialState = { relationships: [], dms: [] };

  getSnapshot = (): SocialState => this.state;

  setRelationships(relationships: readonly Relationship[]): void {
    this.state = { ...this.state, relationships };
    this.emit();
  }

  /** Replace-or-insert one DM (REST responses from create/open/rename/add), keeping the server sort (lastMessageAt desc). */
  mergeDm(dm: DmChannel): void {
    const without = this.state.dms.filter((entry) => entry.id !== dm.id);
    this.state = { ...this.state, dms: sortByRecency([dm, ...without]) };
    this.emit();
  }

  setDms(dms: readonly DmChannel[]): void {
    this.state = { ...this.state, dms: sortByRecency(dms) };
    this.emit();
  }

  getDm(channelId: number): DmChannel | null {
    return this.state.dms.find((entry) => entry.id === channelId) ?? null;
  }

  /** Local half of a self-leave/close — the removed member gets no STOMP event. */
  applyDmClosed(channelId: number): void {
    const next = this.state.dms.filter((entry) => entry.id !== channelId);
    if (next.length === this.state.dms.length) {
      return;
    }
    this.state = { ...this.state, dms: next };
    this.emit();
  }

  /**
   * A live message in a DM: refresh the preview fields and float the row to the
   * top (oak's updateDmPreview). Unknown ids are ignored — the channel may have
   * just been closed locally.
   */
  updateDmLastMessage(message: Message): void {
    const target = this.state.dms.find((entry) => entry.id === message.channelId);
    if (target === undefined || !shouldRefreshPreview(target, message.id)) {
      return;
    }
    this.state = {
      ...this.state,
      dms: sortByRecency([
        {
          ...target,
          lastMessageId: message.id,
          lastMessageAt: message.createdAt,
          lastMessagePreview: message.content,
          lastMessageAuthorName: message.authorUsername,
        },
        ...this.state.dms.filter((entry) => entry.id !== message.channelId),
      ]),
    };
    this.emit();
  }
}

/** lastMessageAt DESC (nulls last), then id DESC — the server's own list order. */
function sortByRecency(dms: readonly DmChannel[]): DmChannel[] {
  return [...dms].sort((left, right) => {
    const leftTime = left.lastMessageAt;
    const rightTime = right.lastMessageAt;
    if (leftTime === null && rightTime === null) {
      return right.id - left.id;
    }
    if (leftTime === null) {
      return 1;
    }
    if (rightTime === null) {
      return -1;
    }
    if (leftTime === rightTime) {
      return right.id - left.id;
    }
    return leftTime < rightTime ? 1 : -1;
  });
}
