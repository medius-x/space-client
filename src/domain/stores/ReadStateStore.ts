import { Emitter } from "../lib/store";
import { messageMentionsUser } from "../logic/notification-decider";
import type { ChannelReadState, Message } from "../../types";

export interface UnreadState {
  unreadCount: number;
  mentionCount: number;
  lastReadMessageId: number | null;
}

/**
 * Unread/mention counters per channel. Seeded from the server's read-states
 * snapshot (both counters arrive pre-computed), then bumped locally by live
 * messages; acks clear on open/focus. The map snapshot is replaced on change —
 * selectors read by channel id.
 */
export class ReadStateStore extends Emitter {
  private states = new Map<number, UnreadState>();
  private snapshotMap: ReadonlyMap<number, UnreadState> = this.states;

  getSnapshot = (): ReadonlyMap<number, UnreadState> => this.snapshotMap;

  get(channelId: number): UnreadState {
    return this.states.get(channelId) ?? { unreadCount: 0, mentionCount: 0, lastReadMessageId: null };
  }

  applySnapshot(states: readonly ChannelReadState[]): void {
    for (const state of states) {
      this.states.set(state.channelId, {
        unreadCount: state.unreadCount,
        mentionCount: state.mentionCount,
        lastReadMessageId: state.lastReadMessageId,
      });
    }
    this.rebuild();
  }

  /** A live message landed; returns true when the receiving channel's counters moved. */
  bumpLive(message: Message, ownUsername: string, channelOpen: boolean, windowFocused: boolean): boolean {
    const state = this.states.get(message.channelId);
    if (state === undefined) {
      return false; // channel never acked/seeded — nothing to count against
    }
    if (channelOpen && windowFocused) {
      return false; // the user is watching — not unread
    }
    const mention = messageMentionsUser(message.mentions, ownUsername);
    this.states.set(message.channelId, {
      ...state,
      unreadCount: state.unreadCount + 1,
      mentionCount: state.mentionCount + (mention ? 1 : 0),
    });
    this.rebuild();
    return true;
  }

  /** Local half of ack — the REST call is the caller's business. */
  ack(channelId: number, lastReadMessageId: number | null): void {
    const state = this.states.get(channelId);
    if (state === undefined) {
      if (lastReadMessageId === null) {
        return;
      }
      this.states.set(channelId, { unreadCount: 0, mentionCount: 0, lastReadMessageId });
      this.rebuild();
      return;
    }
    if (state.unreadCount === 0 && state.mentionCount === 0
      && (lastReadMessageId === null || state.lastReadMessageId === lastReadMessageId)) {
      return;
    }
    this.states.set(channelId, {
      unreadCount: 0,
      mentionCount: 0,
      lastReadMessageId: lastReadMessageId ?? state.lastReadMessageId,
    });
    this.rebuild();
  }

  dropChannel(channelId: number): void {
    if (this.states.delete(channelId)) {
      this.rebuild();
    }
  }

  private rebuild(): void {
    this.snapshotMap = new Map(this.states);
    this.emit();
  }
}
