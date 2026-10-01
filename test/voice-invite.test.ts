import { describe, expect, it } from "vitest";
import {
  filterVoiceInviteCandidates,
  onlineVoiceInviteCandidates,
} from "../src/domain/logic/voice-invite";
import type { ServerMember } from "../src/types";

function member(userId: number, username: string, nickname: string): ServerMember {
  return { userId, username, avatarUrl: null, roleIds: [], owner: false, banned: false, nickname };
}

describe("onlineVoiceInviteCandidates", () => {
  it("lists EVERY online member except yourself — friendship is not a precondition", () => {
    const candidates = onlineVoiceInviteCandidates(
      [
        member(1, "alice", "Alice"),
        member(2, "bob", "Bob"),        // a stranger, online — invitable (Discord parity)
        member(3, "carol", "Carol"),    // offline — not listed (a live card is the only delivery)
        member(4, "me", "Me"),          // self
      ],
      new Set(["alice", "bob", "me"]),
      "me",
    );
    expect(candidates.map((candidate) => candidate.username)).toEqual(["alice", "bob"]);
  });

  it("sorts by nickname", () => {
    const candidates = onlineVoiceInviteCandidates(
      [member(2, "zoe", "Zoe"), member(1, "adam", "Adam")],
      new Set(["zoe", "adam"]),
      "me",
    );
    expect(candidates.map((candidate) => candidate.nickname)).toEqual(["Adam", "Zoe"]);
  });

  it("is empty with no members or nobody online", () => {
    expect(onlineVoiceInviteCandidates([], new Set(["x"]), null)).toEqual([]);
    expect(onlineVoiceInviteCandidates([member(1, "alice", "Alice")], new Set(), null)).toEqual([]);
  });
});

describe("filterVoiceInviteCandidates", () => {
  const candidates = [
    { userId: 1, username: "alice", nickname: "Alice" },
    { userId: 2, username: "bob", nickname: "Боб" },
  ];

  it("returns a copy of everything on an empty query", () => {
    expect(filterVoiceInviteCandidates(candidates, "  ")).toEqual(candidates);
  });

  it("matches a case-insensitive nickname substring", () => {
    expect(filterVoiceInviteCandidates(candidates, "ali")).toEqual([candidates[0]]);
    expect(filterVoiceInviteCandidates(candidates, "БОБ")).toEqual([candidates[1]]);
  });

  it("drops non-matching rows", () => {
    expect(filterVoiceInviteCandidates(candidates, "nobody")).toEqual([]);
  });
});
