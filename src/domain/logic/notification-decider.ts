/**
 * Pure notification decision (oak's NotificationDecider, full M7 slice).
 *  - Sound ONLY fires on an effective mention; non-mentions toast only when the
 *    window is out of focus; nothing at all while the user is watching the
 *    receiving channel in a focused window.
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

/** A direct @user mention (never @everyone/@here). */
export function messageMentionsUserDirect(mentionList: readonly { type: string; name?: string }[], ownUsername: string): boolean {
  return mentionList.some((mention) => mention.type === "USER" && mention.name === ownUsername);
}

/** Any @everyone/@here ping. */
export function messageHasEveryoneHere(mentionList: readonly { type: string; name?: string }[]): boolean {
  return mentionList.some((mention) => mention.type === "EVERYONE" || mention.type === "HERE");
}
