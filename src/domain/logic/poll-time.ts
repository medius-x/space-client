import { tf, type UiLang } from "../i18n/i18n";

/**
 * The poll card's "time left" label (user rule 2026-11-25): more than a day → whole
 * days, less than a day but more than an hour → hours, less than an hour → minutes.
 * At/past the deadline the label reads 0 minutes — the closed push flips the card to
 * its finished view anyway. {@code now} is a parameter so the pure function stays
 * testable; the words follow the UI language (default "en" keeps tests green).
 */
export function formatPollRemaining(endsAt: string, now: number, lang: UiLang = "en"): string {
  const remainingMillis = Date.parse(endsAt) - now;
  if (!Number.isFinite(remainingMillis) || remainingMillis <= 0) {
    return tf(lang, "poll.timeLeft.minutes", { count: 0 });
  }
  const remainingMinutes = Math.ceil(remainingMillis / 60_000);
  if (remainingMinutes >= 24 * 60) {
    return tf(lang, "poll.timeLeft.days", { count: Math.floor(remainingMinutes / (24 * 60)) });
  }
  if (remainingMinutes >= 60) {
    return tf(lang, "poll.timeLeft.hours", { count: Math.floor(remainingMinutes / 60) });
  }
  return tf(lang, "poll.timeLeft.minutes", { count: remainingMinutes });
}
