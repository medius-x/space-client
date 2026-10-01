import { describe, expect, it } from "vitest";
import { isOutgoingPending, transferCandidates } from "../src/domain/logic/ownership-transfer";
import type { OwnershipTransfer, ServerMember } from "../src/types";

function member(userId: number, nickname: string, banned = false): ServerMember {
  return { userId, username: `login${userId}`, avatarUrl: null, roleIds: [], owner: false, banned, nickname };
}

function transfer(fromUserId: number): OwnershipTransfer {
  return {
    id: 1,
    fromUserId,
    fromUsername: "from",
    fromDisplayName: "From",
    toUserId: 99,
    toUsername: "to",
    toDisplayName: "To",
    status: "PENDING",
    createdAt: "2026-10-01T10:00:00Z",
  };
}

describe("transferCandidates", () => {
  it("excludes self and banned members, sorts by nickname", () => {
    const candidates = transferCandidates(
      [
        member(1, "Zed"),
        member(2, "Alice"),
        member(3, "Banned Bob", true),
        member(4, "Carl"),
      ],
      2,
    );
    expect(candidates.map((candidate) => candidate.nickname)).toEqual(["Carl", "Zed"]);
  });

  it("is empty with no members or only self", () => {
    expect(transferCandidates([], 1)).toEqual([]);
    expect(transferCandidates([member(1, "Only Me")], 1)).toEqual([]);
  });
});

describe("isOutgoingPending", () => {
  it("is true only for this member's own pending offer", () => {
    expect(isOutgoingPending(transfer(7), 7)).toBe(true);
    expect(isOutgoingPending(transfer(7), 99)).toBe(false);
    expect(isOutgoingPending(null, 7)).toBe(false);
  });
});
