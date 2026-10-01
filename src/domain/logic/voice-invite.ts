import type { ServerMember } from "../../types";

/** One invitable row of the voice-channel picker (the roster's member row). */
export interface VoiceInviteCandidate {
  userId: number;
  /** The LOGIN — the wire's `to` (the call.signal addressing). */
  username: string;
  /** The NICKNAME — the only rendered name (the rename model). */
  nickname: string;
}

/**
 * Candidates for the voice-room invite picker (the sidebar's hover button):
 * EVERY online member of the server except yourself (user decision — Discord
 * parity; friendship is not a precondition). Offline members are not listed:
 * the card is a live delivery with no persistence, so they would never see it.
 */
export function onlineVoiceInviteCandidates(
  members: readonly ServerMember[],
  onlineUsernames: ReadonlySet<string>,
  selfUsername: string | null,
): VoiceInviteCandidate[] {
  return members
    .filter((member) => member.username !== selfUsername && onlineUsernames.has(member.username))
    .map((member) => ({ userId: member.userId, username: member.username, nickname: member.nickname }))
    .sort((left, right) => left.nickname.localeCompare(right.nickname));
}

/** The picker's search filter — a case-insensitive substring over the NICKNAME. */
export function filterVoiceInviteCandidates(
  candidates: readonly VoiceInviteCandidate[],
  query: string,
): VoiceInviteCandidate[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...candidates];
  }
  return candidates.filter((candidate) => candidate.nickname.toLowerCase().includes(needle));
}
