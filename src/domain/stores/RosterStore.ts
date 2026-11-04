import { Emitter } from "../lib/store";
import type { PresenceEvent, PresenceStatus, UserSummary, VoiceAfkStatusEvent, VoiceMemberEvent } from "../../types";

/**
 * Per-connection roster: users, presence set, voice-channel membership. Fed by the
 * initial REST snapshot plus /topic/presence and /topic/voice. The full hoisted/
 * colored roster is M6 — this is the online list the sidebar shows today.
 */
export interface RosterState {
  users: readonly UserSummary[];
  presence: ReadonlySet<string>;
  /** Online voice members whose activity heartbeat is older than the AFK timeout
   *  (2026-11-04) — the roster dot tints yellow; a fresh heartbeat returns green. */
  afk: ReadonlySet<string>;
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
}

export class RosterStore extends Emitter {
  private state: RosterState = {
    users: [],
    presence: new Set<string>(),
    afk: new Set<string>(),
    voiceMembers: new Map<number, ReadonlySet<string>>(),
  };
  /**
   * Snapshot/delta race guard (oak's pendingDeltas): presence deltas arriving while
   * a snapshot is IN FLIGHT are buffered and re-applied over it — a snapshot taken
   * a moment earlier would otherwise resurrect a user who just went offline (or
   * bury one who just came online).
   */
  private presenceSnapshotInFlight = false;
  private readonly pendingPresenceDeltas = new Map<string, PresenceStatus>();
  /** The same guard for the AFK dimension (seeded by GET /api/voice/afk, flipped
   *  by /topic/voice.afk) — without it, a flip racing the fetch waits for the NEXT
   *  flip to self-correct (up to one AFK timeout later). */
  private afkSnapshotInFlight = false;
  private readonly pendingAfkDeltas = new Map<string, boolean>();

  getSnapshot = (): RosterState => this.state;

  setUsers(users: readonly UserSummary[]): void {
    if (users === this.state.users) {
      return;
    }
    this.state = { ...this.state, users };
    this.emit();
  }

  /** Marks the snapshot window open — deltas from now on are buffered, not applied. */
  beginPresenceSnapshot(): void {
    this.presenceSnapshotInFlight = true;
  }

  /** Applies the snapshot, then replays the deltas that raced it (newest wins). */
  setPresence(usernames: readonly string[]): void {
    const presence = new Set(usernames);
    for (const [username, status] of this.pendingPresenceDeltas) {
      if (status === "ONLINE") {
        presence.add(username);
      } else {
        presence.delete(username);
      }
    }
    this.pendingPresenceDeltas.clear();
    this.presenceSnapshotInFlight = false;
    this.state = { ...this.state, presence };
    this.emit();
  }

  /** A failed snapshot must not leave the buffer open forever — replay onto the current state. */
  abortPresenceSnapshot(): void {
    if (!this.presenceSnapshotInFlight) {
      return;
    }
    const current = [...this.state.presence];
    this.setPresence(current);
  }

  setVoiceMembers(entries: readonly { channelId: number; usernames: string[] }[]): void {
    this.state = {
      ...this.state,
      voiceMembers: new Map(entries.map((entry) => [entry.channelId, new Set(entry.usernames)])),
    };
    this.emit();
  }

  applyPresenceEvent(event: PresenceEvent): void {
    if (this.presenceSnapshotInFlight) {
      this.pendingPresenceDeltas.set(event.username, event.status); // last write per user wins
      return;
    }
    const presence = new Set(this.state.presence);
    if (event.status === "ONLINE") {
      presence.add(event.username);
    } else {
      presence.delete(event.username);
    }
    // Going fully offline wins over any AFK tint (the dot turns grey anyway) —
    // keeps the set from holding stale entries for users not even connected.
    const afk = new Set(this.state.afk);
    if (event.status !== "ONLINE") {
      afk.delete(event.username);
    }
    this.state = { ...this.state, presence, afk };
    this.emit();
  }

  /** Marks the AFK snapshot window open — flips from now on are buffered, not applied. */
  beginAfkSnapshot(): void {
    this.afkSnapshotInFlight = true;
  }

  /** Applies the AFK snapshot, then replays the flips that raced it (last write wins). */
  setVoiceAfk(usernames: readonly string[]): void {
    const afk = new Set(usernames);
    for (const [username, away] of this.pendingAfkDeltas) {
      if (away) {
        afk.add(username);
      } else {
        afk.delete(username);
      }
    }
    this.pendingAfkDeltas.clear();
    this.afkSnapshotInFlight = false;
    this.state = { ...this.state, afk };
    this.emit();
  }

  /** A failed snapshot must not leave the buffer open forever — replay onto the current state. */
  abortAfkSnapshot(): void {
    if (!this.afkSnapshotInFlight) {
      return;
    }
    this.setVoiceAfk([...this.state.afk]);
  }

  /** /topic/voice.afk — one flip per transition; a no-op flip does not emit. */
  applyAfkEvent(event: VoiceAfkStatusEvent): void {
    if (this.afkSnapshotInFlight) {
      this.pendingAfkDeltas.set(event.username, event.afk);
      return;
    }
    if (this.state.afk.has(event.username) === event.afk) {
      return;
    }
    const afk = new Set(this.state.afk);
    if (event.afk) {
      afk.add(event.username);
    } else {
      afk.delete(event.username);
    }
    this.state = { ...this.state, afk };
    this.emit();
  }

  /** /topic/users push (avatar confirm/remove, future renames) — replace by id. */
  updateUser(user: UserSummary): void {
    const existing = this.state.users.find((entry) => entry.id === user.id);
    if (existing === undefined) {
      this.state = { ...this.state, users: [...this.state.users, user] };
      this.emit();
      return;
    }
    if (existing.username === user.username && existing.avatarKey === user.avatarKey && existing.avatarUrl === user.avatarUrl) {
      return;
    }
    this.state = {
      ...this.state,
      users: this.state.users.map((entry) => (entry.id === user.id ? user : entry)),
    };
    this.emit();
  }

  applyVoiceEvent(event: VoiceMemberEvent): void {
    const voiceMembers = new Map(this.state.voiceMembers);
    const current = new Set(voiceMembers.get(event.channelId) ?? []);
    if (event.status === "JOINED") {
      current.add(event.username);
    } else {
      current.delete(event.username);
    }
    voiceMembers.set(event.channelId, current);
    this.state = { ...this.state, voiceMembers };
    this.emit();
  }
}
