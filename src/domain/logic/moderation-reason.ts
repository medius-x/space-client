import type { MemberKickEvent } from "../../types";
import type { UiLang } from "../i18n/i18n";
import { tf } from "../i18n/i18n";

/**
 * The victim-side copy of the /user/queue/member.kick push: the login-modal title
 * and the reason line. Three outcomes share one wire event — a plain disconnect
 * (the victim may simply reconnect), a ban (a moderator must unban), and a
 * PERMANENT removal (the account is anonymized server-side; there is nothing to
 * reconnect to, so no reconnect hint is offered). The lang parameter defaults to
 * "en" (the pre-i18n test assertions stay green); runtime passes currentLang().
 */
export function memberKickTitle(event: MemberKickEvent, lang: UiLang = "en"): string {
  if (event.removed) {
    return tf(lang, "kick.titleRemoved");
  }
  return event.banned ? tf(lang, "kick.titleBanned") : tf(lang, "kick.titleDisconnected");
}

export function memberKickReasonText(event: MemberKickEvent, lang: UiLang = "en"): string {
  if (event.removed) {
    return tf(lang, "kick.reasonRemoved", { by: event.by });
  }
  if (event.banned) {
    return tf(lang, "kick.reasonBanned", { by: event.by });
  }
  return tf(lang, "kick.reasonDisconnected", { by: event.by });
}
