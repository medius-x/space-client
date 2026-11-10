/**
 * Share-quality memory (user request 2026-11-10): the picker's step 2 used to
 * open on the static DEFAULT_PICKER_QUALITY every time. Now the LAST quality
 * that actually went out the door seeds the next share, and WINDOWS get a
 * stronger memory — a share remembers the quality per window TITLE, so
 * re-sharing the same window (same title) reopens exactly that quality. The
 * title map is capped: the NEWEST {@link MAX_WINDOW_QUALITY_MEMORIES} titles
 * survive, the oldest insertion falls off (the record's key order is the
 * insertion order, so the trim is a tail slice).
 *
 * Everything here is plain data plumbing for the client-settings KV — no
 * Chromium types, no side effects; the picker clamps whatever it reads to
 * what the source can feed (clampQualityToSource stays the caller's job).
 */
import type { SavedSharePreset, ShareQuality } from "./share-quality";

/** How many window titles keep their quality memory (user decision: 10). */
export const MAX_WINDOW_QUALITY_MEMORIES = 10;

/**
 * What a share remembers (user request 2026-11-10): the quality that actually
 * went out the door PLUS the preset's NAME when the share rode a NAMED preset
 * untouched (no segment edits). The name lets the next share re-open the
 * picker on the same preset ROW — not merely on matching numbers, which a
 * builtin or an earlier-listed preset could satisfy first.
 */
export interface RememberedShareSelection {
  quality: ShareQuality;
  /** The named preset the share used, null for a Custom (segment-tuned) share. */
  presetName: string | null;
}

/** A hand-edited or foreign KV value must not crash the picker — validate. */
export function sanitizeShareQuality(raw: unknown): ShareQuality | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const { fps, width, height, bitrate } = candidate;
  const validDimension = (value: unknown): value is number | null =>
    value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  if (typeof bitrate !== "number" || !Number.isFinite(bitrate) || bitrate <= 0) {
    return null;
  }
  if (!validDimension(width) || !validDimension(height)) {
    return null;
  }
  if ((width === null) !== (height === null)) { // "Source" is BOTH null or neither
    return null;
  }
  return { fps, width, height, bitrate };
}

export function sanitizeRememberedSelection(raw: unknown): RememberedShareSelection | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const quality = sanitizeShareQuality(candidate.quality);
  if (quality === null) {
    return null;
  }
  const presetName = candidate.presetName;
  return { quality, presetName: typeof presetName === "string" && presetName.trim().length > 0 ? presetName : null };
}

/**
 * Restore the combo preset for a remembered selection: the NAME wins when a
 * preset by that name still exists AND still carries the remembered values
 * (it may have been deleted or re-saved with other numbers) — otherwise the
 * first preset matching the plain values (the old behavior), else null
 * (Custom: the segments alone carry the pick).
 */
export function restorePreset(
  remembered: RememberedShareSelection | null,
  presets: readonly SavedSharePreset[],
): SavedSharePreset | null {
  if (remembered === null) {
    return null;
  }
  const byName = typeof remembered.presetName === "string"
    ? presets.find((preset) => preset.name === remembered.presetName)
    : undefined;
  if (byName !== undefined && sameQuality(byName, remembered.quality)) {
    return byName;
  }
  return presets.find((preset) => sameQuality(preset, remembered.quality)) ?? null;
}

function sameQuality(a: ShareQuality, b: ShareQuality): boolean {
  return a.fps === b.fps && a.width === b.width && a.height === b.height && a.bitrate === b.bitrate;
}

/**
 * Upsert a window-title memory: exact-title match (window titles are
 * case-sensitive artifacts of the apps themselves — "terminal — zsh" and
 * "Terminal — zsh" are different windows), re-insertion refreshes the
 * recency order, and the map never grows past the cap.
 */
export function upsertWindowShareQuality(
  memories: Readonly<Record<string, RememberedShareSelection>>,
  windowTitle: string,
  selection: RememberedShareSelection,
): Record<string, RememberedShareSelection> {
  const key = windowTitle.trim();
  if (key.length === 0) {
    return { ...memories }; // a titleless window cannot be re-matched anyway
  }
  const without = { ...memories };
  delete without[key];
  without[key] = selection;
  const keys = Object.keys(without);
  if (keys.length <= MAX_WINDOW_QUALITY_MEMORIES) {
    return without;
  }
  const trimmed: Record<string, RememberedShareSelection> = {};
  for (const key_ of keys.slice(keys.length - MAX_WINDOW_QUALITY_MEMORIES)) {
    trimmed[key_] = without[key_]!;
  }
  return trimmed;
}

/** The remembered selection for this exact window title, null when unseen. */
export function rememberedWindowQuality(
  memories: Readonly<Record<string, RememberedShareSelection>>,
  windowTitle: string,
): RememberedShareSelection | null {
  return memories[windowTitle.trim()] ?? null;
}

/** Loader sanitize: drop garbage entries and keep only the NEWEST cap titles. */
export function sanitizeWindowShareQualities(raw: unknown): Record<string, RememberedShareSelection> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const sanitized: Record<string, RememberedShareSelection> = {};
  for (const [title, value] of Object.entries(raw as Record<string, unknown>)) {
    const selection = sanitizeRememberedSelection(value);
    if (selection !== null && title.trim().length > 0) {
      delete sanitized[title]; // refresh insertion order on re-key (paranoia)
      sanitized[title] = selection;
    }
  }
  const keys = Object.keys(sanitized);
  if (keys.length <= MAX_WINDOW_QUALITY_MEMORIES) {
    return sanitized;
  }
  const trimmed: Record<string, RememberedShareSelection> = {};
  for (const key of keys.slice(keys.length - MAX_WINDOW_QUALITY_MEMORIES)) {
    trimmed[key] = sanitized[key]!;
  }
  return trimmed;
}
