import { describe, expect, it } from "vitest";
import {
  membershipCandidates,
  membershipRows,
  nextRoleIdsFor,
  reconcileMembershipPending,
  type MembershipIntent,
} from "../src/domain/logic/role-membership";
import type { ServerMember } from "../src/types";

function pendingOf(entries: [number, MembershipIntent][]): Map<number, MembershipIntent> {
  return new Map(entries);
}

function member(userId: number, nickname: string, roleIds: number[] = []): ServerMember {
  return { userId, username: `u${userId}`, avatarUrl: null, roleIds, owner: false, banned: false, nickname };
}

describe("staged role membership (Roles editor, Members tab)", () => {
  const members = [
    member(1, "Alice", [10]),
    member(2, "Bob", []),
    member(3, "Cara", [10, 20]),
  ];

  it("rows = snapshot holders + staged adds - staged removals, each tagged", () => {
    const pending = pendingOf([[2, "add"], [1, "remove"]]);
    expect(membershipRows(members, 10, pending).map((row) => [row.member.userId, row.state]))
      .toEqual([[1, "pending-remove"], [2, "pending-add"], [3, "held"]]);
    // No pendings: the plain holder list.
    expect(membershipRows(members, 10, new Map()).map((row) => row.member.userId)).toEqual([1, 3]);
  });

  it("a staged removal of someone who lost the role server-side disappears", () => {
    const withoutRole = [member(1, "Alice", []), member(2, "Bob", [])];
    expect(membershipRows(withoutRole, 10, pendingOf([[1, "remove"]])).map((row) => row.member.userId))
      .toEqual([]); // satisfied by reality — not a visible row
  });

  it("candidates exclude holders and already-staged adds", () => {
    expect(membershipCandidates(members, 10, new Map()).map((entry) => entry.userId)).toEqual([2]);
    expect(membershipCandidates(members, 10, pendingOf([[2, "add"]])).map((entry) => entry.userId)).toEqual([]);
  });

  it("nextRoleIdsFor builds the full-replacement PUT body both ways", () => {
    const cara = members[2]!;
    expect(nextRoleIdsFor(cara, 30, "add")).toEqual([10, 20, 30]);
    expect(nextRoleIdsFor(cara, 10, "remove")).toEqual([20]);
    // an add of a role already held does not duplicate
    expect(nextRoleIdsFor(cara, 20, "add")).toEqual([10, 20]);
  });

  it("reconcile drops intents the server already satisfied, keeps the rest", () => {
    // 1's "remove" is satisfied (role gone); 3's "remove" is not; 2's "add" is satisfied.
    const fresh = [member(1, "Alice", []), member(2, "Bob", [10]), member(3, "Cara", [10, 20])];
    const reconciled = reconcileMembershipPending(pendingOf([[1, "remove"], [2, "add"], [3, "remove"]]), fresh, 10);
    expect([...reconciled.entries()]).toEqual([[3, "remove"]]);
  });

  it("reconcile keeps intents for members missing from the snapshot", () => {
    const reconciled = reconcileMembershipPending(pendingOf([[9, "add"]]), members, 10);
    expect([...reconciled.entries()]).toEqual([[9, "add"]]);
  });
});
