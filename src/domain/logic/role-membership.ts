import type { ServerMember } from "../../types";

/**
 * Staged role membership (the Roles editor's Members tab, user decision
 * 2026-10-19): adding/removing a member is NOT an immediate PUT anymore — the
 * change parks in a pending map, the row renders highlighted, and the ONE
 * cross-tab "Save Changes" commits everything. The immediate PUT was a
 * live-report bug: its /topic/members echo refetched the store, fresh Role
 * objects re-seeded the editor's draft, and unsaved edits from the other two
 * tabs were wiped.
 */

export type MembershipIntent = "add" | "remove";
export type MembershipPending = ReadonlyMap<number, MembershipIntent>;

export interface MembershipRow {
  member: ServerMember;
  state: "held" | "pending-add" | "pending-remove";
}

/** The visible holder list: snapshot holders plus staged adds, minus staged
 *  removals — each row tagged for its highlight class. */
export function membershipRows(members: readonly ServerMember[], roleId: number,
  pending: MembershipPending): MembershipRow[] {
  const rows: MembershipRow[] = [];
  for (const member of members) {
    const holds = member.roleIds.includes(roleId);
    const intent = pending.get(member.userId);
    if (intent === "add") {
      rows.push({ member, state: "pending-add" });
    } else if (intent === "remove") {
      if (holds) {
        rows.push({ member, state: "pending-remove" });
      }
      // A staged removal of someone who lost the role server-side is a no-op.
    } else if (holds) {
      rows.push({ member, state: "held" });
    }
  }
  return rows;
}

/** Picker candidates: members without the role AND without a staged add. */
export function membershipCandidates(members: readonly ServerMember[], roleId: number,
  pending: MembershipPending): ServerMember[] {
  return [...members]
    .filter((member) => !member.roleIds.includes(roleId) && pending.get(member.userId) !== "add")
    .sort((left, right) => left.nickname.localeCompare(right.nickname));
}

/** The PUT body for one staged change: the member's CURRENT roleIds ± the role
 *  (full replacement is the endpoint's contract). */
export function nextRoleIdsFor(member: ServerMember, roleId: number, intent: MembershipIntent): number[] {
  return intent === "add"
    ? [...new Set([...member.roleIds, roleId])]
    : member.roleIds.filter((id) => id !== roleId);
}

/**
 * Drop pendings the server has already satisfied (another admin, or our own
 * earlier save): an "add" that is now in roleIds and a "remove" that is now
 * gone are no-ops — keeping them would re-PUT identical bodies forever and
 * keep the editor dirty against reality.
 */
export function reconcileMembershipPending(pending: MembershipPending,
  members: readonly ServerMember[], roleId: number): Map<number, MembershipIntent> {
  const reconciled = new Map(pending);
  if (reconciled.size === 0) {
    return reconciled;
  }
  const byUserId = new Map(members.map((member) => [member.userId, member]));
  for (const [userId, intent] of reconciled) {
    const member = byUserId.get(userId);
    if (member === undefined) {
      continue; // member vanished from the snapshot — keep the intent, the PUT will speak
    }
    const holds = member.roleIds.includes(roleId);
    if ((intent === "add" && holds) || (intent === "remove" && !holds)) {
      reconciled.delete(userId);
    }
  }
  return reconciled;
}
