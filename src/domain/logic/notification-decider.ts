/**
 * Pure notification decision (oak's NotificationDecider, full M7 slice).
 *  - Sound ONLY fires on an effective mention; non-mentions toast only when the
 *    window is out of focus; nothing at all while the user is watching the
 *    receiving channel in a focused window.
 *  - A mention is: a direct @user (by id), an @role the user holds (by id), or
 *    an unsuppressed @everyone/@here.
 *  - Per-server mode: MENTIONS + non-mention → nothing; NOTHING → nothing (the
 *    unread BADGE still counts — mode only gates toasts/sounds, oak parity).
 *  - suppressEveryoneHere: @everyone/@here does not count as a mention for the
 *    toast/sound/red badge (the message still lands in the unread counter).
 */
export type NotificationAction = "none" | "toast" | "toast-sound";

export interface NotificationInput {
  /** A DIRECT @user mention. */
  mention: boolean;
  /** An @everyone/@here ping is present. */
  everyoneHere: boolean;
  windowFocused: boolean;
  inOpenChannel: boolean;
  serverMode: "ALL" | "MENTIONS" | "NOTHING";
  suppressEveryoneHere: boolean;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
}

export function decideNotification(input: NotificationInput): NotificationAction {
  if (!input.notificationsEnabled) {
    return "none";
  }
  if (input.inOpenChannel && input.windowFocused) {
    return "none";
  }
  const effectiveMention = input.mention || (input.everyoneHere && !input.suppressEveryoneHere);
  if (input.serverMode === "NOTHING" || (input.serverMode === "MENTIONS" && !effectiveMention)) {
    return "none";
  }
  if (!effectiveMention) {
    return input.windowFocused ? "none" : "toast";
  }
  return input.soundEnabled ? "toast-sound" : "toast";
}

/** Who the signed-in user is on THIS instance — the mention match key. userId is
 *  null and roleIds empty before the roster lands; nothing matches then (oak's
 *  "safe before the roster" rule — better a missed ping than a false one). */
export interface MentionIdentity {
  userId: number | null;
  roleIds: readonly number[];
}

/** A direct @user mention by user id (never @everyone/@here) — id, not name,
 *  because a rename must not break the match (oak matches by id). */
export function messageMentionsUser(mentionList: readonly { type: string; id: number | null }[], userId: number | null): boolean {
  if (userId === null) {
    return false;
  }
  return mentionList.some((mention) => mention.type === "USER" && mention.id === userId);
}

/** An @role mention of a role the user holds — a full mention (red badge, bell),
 *  oak parity: ROLE hits against the member's own role ids. */
export function messageMentionsRole(mentionList: readonly { type: string; id: number | null }[], roleIds: readonly number[]): boolean {
  if (roleIds.length === 0) {
    return false;
  }
  const held = new Set(roleIds);
  return mentionList.some((mention) => mention.type === "ROLE" && mention.id !== null && held.has(mention.id));
}

/** Any @everyone/@here ping. */
export function messageHasEveryoneHere(mentionList: readonly { type: string; name?: string }[]): boolean {
  return mentionList.some((mention) => mention.type === "EVERYONE" || mention.type === "HERE");
}
