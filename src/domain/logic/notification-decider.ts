/**
 * Pure notification decision (oak's NotificationDecider, M2 slice — per-server
 * prefs arrive with the settings milestone). Sound ONLY fires on a mention;
 * non-mentions toast only when the window is out of focus; nothing at all while
 * the user is watching the receiving channel in a focused window.
 */
export type NotificationAction = "none" | "toast" | "toast-sound";

export interface NotificationInput {
  mention: boolean;
  windowFocused: boolean;
  inOpenChannel: boolean;
}

export function decideNotification(input: NotificationInput): NotificationAction {
  if (input.inOpenChannel && input.windowFocused) {
    return "none";
  }
  return input.mention ? "toast-sound" : input.windowFocused ? "none" : "toast";
}

/** Does this message @-mention the given user? (USER by name; EVERYONE/HERE always.) */
export function messageMentionsUser(mentionList: readonly { type: string; name: string }[], ownUsername: string): boolean {
  return mentionList.some((mention) =>
    mention.type === "USER" && mention.name === ownUsername
    || mention.type === "EVERYONE"
    || mention.type === "HERE",
  );
}
