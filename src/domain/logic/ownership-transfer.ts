import type { OwnershipTransfer, ServerMember } from "../../types";

/**
 * The offer-picker candidates: every plain member except the owner themselves.
 * Banned members are excluded (they cannot log in to accept); removed members never
 * appear in GET /api/members at all.
 */
export function transferCandidates(
  members: readonly ServerMember[],
  selfUserId: number,
): ServerMember[] {
  return members
    .filter((member) => member.userId !== selfUserId && !member.banned)
    .sort((left, right) => left.nickname.localeCompare(right.nickname));
}

/** Whether the live pending offer is THIS member's outgoing one (they are the sender). */
export function isOutgoingPending(
  transfer: OwnershipTransfer | null,
  selfUserId: number,
): boolean {
  return transfer !== null && transfer.fromUserId === selfUserId;
}
