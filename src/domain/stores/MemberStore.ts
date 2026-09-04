import { Emitter } from "../lib/store";
import type { Role, ServerMember } from "../../types";

/**
 * Per-connection member roster WITH roles (GET /api/members + GET /api/roles).
 * Refresh-fed: /topic/members and /topic/roles arrive as contentless pings —
 * the session refetches both. Derived views (hoist groups, nick colors,
 * hierarchy hints) are pure functions in logic/roster-grouping.ts.
 *
 * Snapshot contract: getSnapshot returns the SAME object until a setter runs —
 * useSyncExternalStore turns a fresh literal into an infinite re-render loop.
 */
export interface MemberRosterState {
  members: readonly ServerMember[];
  roles: readonly Role[];
}

export class MemberStore extends Emitter {
  private state: MemberRosterState = { members: [], roles: [] };

  getSnapshot = (): MemberRosterState => this.state;

  setMembers(members: readonly ServerMember[]): void {
    this.state = { ...this.state, members };
    this.emit();
  }

  setRoles(roles: readonly Role[]): void {
    this.state = { ...this.state, roles };
    this.emit();
  }

  memberByUsername(username: string): ServerMember | null {
    return this.state.members.find((member) => member.username === username) ?? null;
  }
}
