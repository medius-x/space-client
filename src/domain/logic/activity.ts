/**
 * The user-set roster activity ("playing CS2", 2026-11-10; AUTO-DETECT rework
 * 2026-11-11): a REGISTERED RULE binds an exe NAME to a line — while a
 * process with that name is running, the line shows under the user's name in
 * every roster; when it closes, the line goes. The Discord game-detection
 * model minus the game database: the user registers the apps themselves.
 * The prefix verb is localized at RENDER time — this module stays i18n-free.
 */
import type { ActivityKind, PresenceActivity } from "../../types";

export const ACTIVITY_KINDS: readonly ActivityKind[] = ["playing", "listening", "watching", "streaming", "competing"];

export const ACTIVITY_NAME_MAX_LENGTH = 64;

/** How many activity rules a user may keep registered (client settings cap). */
export const MAX_REGISTERED_ACTIVITIES = 20;

/** The i18n key of a kind's prefix: activity.playing, activity.listening, … */
export function activityKindKey(kind: ActivityKind): string {
  return `activity.${kind}`;
}

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** The icon a rule persists once the describe pass has seen the app (a 16×16
 *  data URL): the rule keeps its glyph while the app is NOT running. A 16×16
 *  PNG is a few hundred bytes — anything past this cap is hand-edited KV, not
 *  our icon, and drops to null. */
export const ACTIVITY_ICON_MAX_LENGTH = 8192;

/** A persisted activity icon must be a small data-URL image; anything else
 *  (wrong type, wrong prefix, oversized) reads as "no icon". */
export function sanitizeActivityIcon(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("data:image/") || raw.length > ACTIVITY_ICON_MAX_LENGTH) {
    return null;
  }
  return raw;
}

/** Same validation as the server's handler: unknown verb / blank / oversized name
 *  is not a line at all — a hostile value from a hand-edited KV never reaches the wire. */
export function sanitizeActivity(value: unknown): PresenceActivity | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as { type?: unknown; name?: unknown };
  if (!isActivityKind(candidate.type)) {
    return null;
  }
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (name.length === 0 || name.length > ACTIVITY_NAME_MAX_LENGTH) {
    return null;
  }
  return { type: candidate.type, name };
}

/** A rule's exe name, normalized: basename, lowercase (Windows matching is
 *  case-insensitive). Null for anything that is not a plausible exe name. */
export function normalizeProcessName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const base = value.split(/[\\/]/).pop() ?? "";
  const normalized = base.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 100 || !normalized.endsWith(".exe")) {
    return null;
  }
  return normalized;
}

/**
 * The auto-detect verdict (LIFO rework, user request 2026-11-11): among the
 * rules whose process is running, the one whose exe was DETECTED LATEST wins —
 * launching B over a running A shows B; closing B falls back to A. Detection
 * stamps come from trackProcessDetection (the poll's own sightings — a restart
 * re-stamps an exe). Exes without a stamp tie at "earliest": ties keep the
 * FIRST registered rule (registration order — deterministic, the way it was
 * before the rework). Null when nothing matches.
 */
export function matchRunningActivity(
  rules: readonly { processName: string; type: ActivityKind; name: string }[],
  runningProcessNames: Iterable<string>,
  detectedAtByName?: ReadonlyMap<string, number>,
): PresenceActivity | null {
  const running = new Set(runningProcessNames);
  let bestRule: { processName: string; type: ActivityKind; name: string } | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const rule of rules) {
    if (!running.has(rule.processName)) {
      continue;
    }
    const at = detectedAtByName?.get(rule.processName) ?? Number.NEGATIVE_INFINITY;
    if (bestRule === null || at > bestAt) { // strict >: equal stamps keep the earlier rule
      bestRule = rule;
      bestAt = at;
    }
  }
  return bestRule === null ? null : { type: bestRule.type, name: bestRule.name };
}

/**
 * The detection-order tracker feeding matchRunningActivity's LIFO verdict:
 * names newly seen in the snapshot stamp NOW, names that left drop their stamp
 * (so a restarted exe re-stamps and outranks what stayed running). Mutates
 * the caller-held map and returns it for the verdict pass. `nowMillis` is
 * injected — the unit tests drive the clock.
 */
export function trackProcessDetection(
  stamps: Map<string, number>,
  runningProcessNames: Iterable<string>,
  nowMillis: number,
): ReadonlyMap<string, number> {
  const running = new Set(runningProcessNames);
  for (const name of stamps.keys()) {
    if (!running.has(name)) {
      stamps.delete(name);
    }
  }
  for (const name of running) {
    if (!stamps.has(name)) {
      stamps.set(name, nowMillis);
    }
  }
  return stamps;
}
