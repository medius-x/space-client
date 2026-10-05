/**
 * The client-side view of the private-message restriction (the subtractive
 * RESTRICT_PRIVATE_MESSAGES role bit). The server is the authority — every send
 * path 403s there; this only keeps the composer and the DM entry points honest.
 *
 * Semantics (user decisions, mirrored in AuthorizationService.requireDmSendAllowed):
 * a restricted member can neither send nor receive; a 1:1 with one is frozen for
 * BOTH sides (a message toward them would be a received one); a group DM only
 * silences the restricted member themselves.
 */

export type DmSendBlockReason = "self" | "peer";

/** Why the composer is closed in this conversation, or null when writing is allowed.
 *  `peerRestricted` only matters for a 1:1 — a group with a restricted member stays
 *  writable for everyone else. */
export function dmSendBlockReason(myRestricted: boolean, peerRestricted: boolean | null, groupDm: boolean): DmSendBlockReason | null {
  if (myRestricted) {
    return "self";
  }
  if (!groupDm && peerRestricted === true) {
    return "peer";
  }
  return null;
}

/** The muted plate shown where the composer would be (the composer hides the same
 *  way it does for a server channel without SEND_MESSAGES). */
export function dmBlockHintText(reason: DmSendBlockReason): string {
  return reason === "self"
    ? "You are not allowed to send private messages on this server."
    : "This member cannot receive private messages.";
}
