import type { MemberKickEvent } from "../../types";

/**
 * The victim-side copy of the /user/queue/member.kick push: the login-modal title
 * and the reason line. Three outcomes share one wire event — a plain disconnect
 * (the victim may simply reconnect), a ban (a moderator must unban), and a
 * PERMANENT removal (the account is anonymized server-side; there is nothing to
 * reconnect to, so no reconnect hint is offered).
 */
export function memberKickTitle(event: MemberKickEvent): string {
  if (event.removed) {
    return "Removed from server";
  }
  return event.banned ? "Banned" : "Disconnected";
}

export function memberKickReasonText(event: MemberKickEvent): string {
  if (event.removed) {
    return `You were removed from the server by ${event.by}. You can no longer join this server.`;
  }
  if (event.banned) {
    return `You were banned by ${event.by}. A moderator must unban you before reconnecting.`;
  }
  return `You were disconnected by ${event.by}. Click the server again to reconnect.`;
}
