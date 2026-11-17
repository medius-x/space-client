/**
 * The STATUS-driven notification policy (user request 2026-11-17, the manual
 * statuses round): what the notification hub may do while the user sits in a
 * given status — pure math over (statusOverride, autoAway), testable without
 * stores. The hub receives a LIVE accessor built on this; the runtime flips
 * the accessor's inputs as the status machine decides.
 *
 * The matrix (user-signed):
 *  - online           — everything as before;
 *  - away (AUTO)      — no message sound; message toasts STICKY (no auto-dismiss
 *                       until closed by hand; returning online re-arms the usual
 *                       auto-dismiss on the standing ones); the call chime stays;
 *  - away (MANUAL)    — no message sound; message toasts hidden entirely; the
 *                       call chime stays;
 *  - dnd / invisible  — no message sound, no call chime, message toasts hidden;
 *                       the call CARD still shows (silent);
 * knocks, mute cues and the caller's own ringback are the user's OWN actions
 * and never gate.
 */
export type StatusOverride = "auto" | "online" | "away" | "dnd" | "invisible";

/** What the message-toast lane does in this mode. */
export type MessageToastPolicy = "shown" | "sticky" | "hidden";

export interface NotificationPolicy {
  /** The message/mention bell may sound. */
  messageSound: boolean;
  /** The message-toast lane's behavior. */
  messageToast: MessageToastPolicy;
  /** The incoming-call chime may sound (the call CARD always shows). */
  callSound: boolean;
}

/** The status-mode the policy derives from: the override pin, or the auto
 *  verdict when the override is "auto" (awayNow = the auto-mode's idle flip). */
export function notificationPolicyMode(override: StatusOverride, awayNow: boolean):
  "online" | "away-auto" | "away-manual" | "quiet" {
  if (override === "dnd" || override === "invisible") {
    return "quiet";
  }
  if (override === "away") {
    return "away-manual";
  }
  if (override === "auto" && awayNow) {
    return "away-auto";
  }
  return "online";
}

/** The policy matrix itself. */
export function notificationPolicy(mode: ReturnType<typeof notificationPolicyMode>): NotificationPolicy {
  switch (mode) {
    case "online":
      return { messageSound: true, messageToast: "shown", callSound: true };
    case "away-auto":
      return { messageSound: false, messageToast: "sticky", callSound: true };
    case "away-manual":
      return { messageSound: false, messageToast: "hidden", callSound: true };
    case "quiet":
      return { messageSound: false, messageToast: "hidden", callSound: false };
  }
}
