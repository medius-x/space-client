import { Emitter } from "../lib/store";
import type { PresenceActivity, PresenceActivityEvent, PresenceEvent, PresenceStatus, PresenceStatusEvent, RosterStatus, UserSummary, VoiceAfkStatusEvent, VoiceMemberEvent } from "../../types";

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
  /** The STATUS dimension (the status menu, 2026-11-17): username → their non-online
   *  status ("away" | "dnd"); absent = online. Seeded by GET /api/presence/status,
   *  flipped by /topic/roster.status; presence OFFLINE drops the entry locally. The
   *  legacy afk set above keeps rendering on servers without the roster-status flag. */
  statuses: ReadonlyMap<string, Exclude<RosterStatus, "online">>;
  /** The roster ACTIVITY lines (2026-11-10, "playing CS2") — username → their line;
   *  absent = no line. Seeded by GET /api/presence/activities, flipped by
   *  /topic/presence.activity; presence OFFLINE drops the line locally. */
  activities: ReadonlyMap<string, PresenceActivity>;
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
}

export class RosterStore extends Emitter {
  private state: RosterState = {
    users: [],
    presence: new Set<string>(),
    afk: new Set<string>(),
    statuses: new Map<string, Exclude<RosterStatus, "online">>(),
    activities: new Map<string, PresenceActivity>(),
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
  /** The same guard for the STATUS dimension (seeded by GET /api/presence/status,
   *  flipped by /topic/roster.status). */
  private statusSnapshotInFlight = false;
  private readonly pendingStatusDeltas = new Map<string, PresenceStatusEvent["status"]>();
  /** The same guard for the ACTIVITY dimension (seeded by GET /api/presence/activities,
   *  changed by /topic/presence.activity) — a change racing the fetch waits otherwise. */
  private activitySnapshotInFlight = false;
  private readonly pendingActivityDeltas = new Map<string, PresenceActivity | null>();

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
    const statuses = new Map(this.state.statuses);
    const activities = new Map(this.state.activities);
    if (event.status !== "ONLINE") {
      afk.delete(event.username);
      statuses.delete(event.username);
      // Offline drops the activity line too (the server drops it silently —
      // its last-session disconnect clear never broadcasts).
      activities.delete(event.username);
    }
    this.state = { ...this.state, presence, afk, statuses, activities };
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

  /** Marks the STATUS snapshot window open — flips from now on are buffered. */
  beginStatusSnapshot(): void {
    this.statusSnapshotInFlight = true;
  }

  /** Applies the status snapshot (the non-online sets), then replays the flips that
   *  raced it (last write wins). */
  setStatuses(snapshot: { away: readonly string[]; dnd: readonly string[] }): void {
    const statuses = new Map<string, Exclude<RosterStatus, "online">>();
    for (const username of snapshot.away) {
      statuses.set(username, "away");
    }
    for (const username of snapshot.dnd) {
      statuses.set(username, "dnd");
    }
    for (const [username, status] of this.pendingStatusDeltas) {
      if (status === "online") {
        statuses.delete(username);
      } else {
        statuses.set(username, status);
      }
    }
    this.pendingStatusDeltas.clear();
    this.statusSnapshotInFlight = false;
    this.state = { ...this.state, statuses };
    this.emit();
  }

  /** A failed snapshot must not leave the buffer open forever — replay onto the current state. */
  abortStatusSnapshot(): void {
    if (!this.statusSnapshotInFlight) {
      return;
    }
    this.setStatuses({
      away: [...this.state.statuses].filter(([, status]) => status === "away").map(([username]) => username),
      dnd: [...this.state.statuses].filter(([, status]) => status === "dnd").map(([username]) => username),
    });
  }

  /** /topic/roster.status — one flip per transition; a no-op flip does not emit. */
  applyStatusEvent(event: PresenceStatusEvent): void {
    if (this.statusSnapshotInFlight) {
      this.pendingStatusDeltas.set(event.username, event.status);
      return;
    }
    const current = this.state.statuses.get(event.username) ?? "online";
    if (current === event.status) {
      return;
    }
    const statuses = new Map(this.state.statuses);
    if (event.status === "online") {
      statuses.delete(event.username);
    } else {
      statuses.set(event.username, event.status);
    }
    this.state = { ...this.state, statuses };
    this.emit();
  }

  /** Marks the ACTIVITY snapshot window open — changes from now on are buffered. */
  beginActivitySnapshot(): void {
    this.activitySnapshotInFlight = true;
  }

  /** Applies the activity snapshot, then replays the changes that raced it (last wins). */
  setActivities(entries: readonly PresenceActivityEvent[]): void {
    const activities = new Map<string, PresenceActivity>();
    for (const entry of entries) {
      if (entry.activity !== null) {
        activities.set(entry.username, entry.activity);
      }
    }
    for (const [username, activity] of this.pendingActivityDeltas) {
      if (activity === null) {
        activities.delete(username);
      } else {
        activities.set(username, activity);
      }
    }
    this.pendingActivityDeltas.clear();
    this.activitySnapshotInFlight = false;
    this.state = { ...this.state, activities };
    this.emit();
  }

  /** A failed snapshot must not leave the buffer open forever. */
  abortActivitySnapshot(): void {
    if (!this.activitySnapshotInFlight) {
      return;
    }
    this.setActivities([...this.state.activities].map(([username, activity]) =>
      ({ username, activity })));
  }

  /** /topic/presence.activity — a set/replace/clear; a no-op change does not emit. */
  applyActivityEvent(event: PresenceActivityEvent): void {
    if (this.activitySnapshotInFlight) {
      this.pendingActivityDeltas.set(event.username, event.activity);
      return;
    }
    const current = this.state.activities.get(event.username) ?? null;
    const same = event.activity === null
      ? current === null
      : current !== null && current.type === event.activity.type && current.name === event.activity.name;
    if (same) {
      return;
    }
    const activities = new Map(this.state.activities);
    if (event.activity === null) {
      activities.delete(event.username);
    } else {
      activities.set(event.username, event.activity);
    }
    this.state = { ...this.state, activities };
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
