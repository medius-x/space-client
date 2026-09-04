import { Emitter } from "../lib/store";
import type { PresenceEvent, UserSummary, VoiceMemberEvent } from "../../types";

/**
 * Per-connection roster: users, presence set, voice-channel membership. Fed by the
 * initial REST snapshot plus /topic/presence and /topic/voice. The full hoisted/
 * colored roster is M6 — this is the online list the sidebar shows today.
 */
export interface RosterState {
  users: readonly UserSummary[];
  presence: ReadonlySet<string>;
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
}

export class RosterStore extends Emitter {
  private state: RosterState = {
    users: [],
    presence: new Set<string>(),
    voiceMembers: new Map<number, ReadonlySet<string>>(),
  };

  getSnapshot = (): RosterState => this.state;

  setUsers(users: readonly UserSummary[]): void {
    if (users === this.state.users) {
      return;
    }
    this.state = { ...this.state, users };
    this.emit();
  }

  setPresence(usernames: readonly string[]): void {
    this.state = { ...this.state, presence: new Set(usernames) };
    this.emit();
  }

  setVoiceMembers(entries: readonly { channelId: number; usernames: string[] }[]): void {
    this.state = {
      ...this.state,
      voiceMembers: new Map(entries.map((entry) => [entry.channelId, new Set(entry.usernames)])),
    };
    this.emit();
  }

  applyPresenceEvent(event: PresenceEvent): void {
    const presence = new Set(this.state.presence);
    if (event.status === "ONLINE") {
      presence.add(event.username);
    } else {
      presence.delete(event.username);
    }
    this.state = { ...this.state, presence };
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
