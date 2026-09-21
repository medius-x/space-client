/**
 * The share picker's second step (oak ScreenSourcePicker.Picker, ported):
 * a preset combo + three segment rows (frame rate / resolution / bitrate),
 * a saved-preset row and a per-kind audio checkbox all resolve into ONE
 * ShareQuality before the capture starts. Width/height null = the "Source"
 * variant (user decision 2026-09-21, a floor for sources smaller than every
 * preset; oak has no such option — its setMaxFrameSize caps silently).
 *
 * This module also encodes the source-capability cutoff (user decision, an
 * improvement over oak): a preset resolution is only FEASIBLE when both of
 * its dimensions fit the source — requesting more never upscales (Chromium's
 * max-constraints cap), it would merely mislead the picker's user.
 */

/** The picker's decision payload. Bitrate is bits per second. */
export interface ShareQuality {
  fps: number;
  /** null = the "Source" variant — no resolution cap, native capture. */
  width: number | null;
  height: number | null;
  bitrate: number;
}

/** A user-saved preset (persisted in client settings, oak's sharePresets). */
export interface SavedSharePreset extends ShareQuality {
  name: string;
}

export const BUILTIN_PRESETS: readonly SavedSharePreset[] = [
  { name: "Low", fps: 15, width: 1280, height: 720, bitrate: 1_500_000 },
  { name: "Medium", fps: 24, width: 1920, height: 1080, bitrate: 3_000_000 },
  { name: "High", fps: 30, width: 2560, height: 1440, bitrate: 6_000_000 },
];

/** The step-2 default (user decision 2026-09-21): Medium, NOT oak's High. */
const mediumPreset = BUILTIN_PRESETS[1]!;
export const DEFAULT_PICKER_QUALITY: ShareQuality = {
  fps: mediumPreset.fps,
  width: mediumPreset.width,
  height: mediumPreset.height,
  bitrate: mediumPreset.bitrate,
};

export interface ResolutionChoice {
  label: string;
  width: number | null;
  height: number | null;
}

/** Ascending; "Source" first so it always wins the feasibility floor. */
export const RESOLUTION_CHOICES: readonly ResolutionChoice[] = [
  { label: "Source", width: null, height: null },
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "2160p", width: 3840, height: 2160 },
];

export const FPS_CHOICES: readonly number[] = [15, 24, 30, 45, 60, 75, 90];

export const BITRATE_CHOICES_MBPS: readonly number[] = [1.5, 3, 6, 8, 12, 16];

export const MAX_SHARE_PRESETS = 30;

/**
 * The preset resolutions this source can actually feed (user decision: never
 * offer quality above the source). "Source" is always feasible; a preset fits
 * when BOTH dimensions fit; an unknown source size (null) offers everything —
 * the honest fallback when detection is unavailable.
 */
export function feasibleResolutions(sourceWidth: number | null, sourceHeight: number | null): ResolutionChoice[] {
  return RESOLUTION_CHOICES.filter((choice) =>
    choice.width === null
    || choice.height === null
    || sourceWidth === null
    || sourceHeight === null
    || (choice.width <= sourceWidth && choice.height <= sourceHeight));
}

/**
 * Bring a quality down to what the source supports: keep it when its
 * resolution is feasible, otherwise swap in the HIGHEST feasible preset
 * resolution ("Source" when nothing fits). The step-2 default rides this
 * (Medium on a 1280×800 window lands on 720p).
 */
export function clampQualityToSource(quality: ShareQuality, sourceWidth: number | null, sourceHeight: number | null): ShareQuality {
  const feasible = feasibleResolutions(sourceWidth, sourceHeight);
  const chosenFeasible = feasible.some((choice) => choice.width === quality.width && choice.height === quality.height);
  if (chosenFeasible) {
    return quality;
  }
  const highestFeasible = [...feasible].reverse().find((choice) => choice.width !== null) ?? feasible[0]!;
  return { ...quality, width: highestFeasible.width, height: highestFeasible.height };
}

/**
 * oak's resolveQuality: a TOUCHED segment beats the combo preset (the edited
 * value is the pick even before it is saved as a preset), and without a
 * preset selection the segments are the pick. The combo value returns as a
 * CLEAN ShareQuality — the caller hands in SavedSharePreset objects (a
 * structural subtype), and a leaked `name` would later override the typed one
 * in the save row's spread (the "two Mediums" live bug: { name: "Gaming",
 * ...{ name: "Medium" } } landed as Medium).
 */
export function resolveQuality(segmentDirty: boolean, comboValue: ShareQuality | null, segmentState: ShareQuality): ShareQuality {
  if (segmentDirty || comboValue === null) {
    return segmentState;
  }
  return { fps: comboValue.fps, width: comboValue.width, height: comboValue.height, bitrate: comboValue.bitrate };
}

export function formatBitrate(bitrate: number): string {
  const megabits = bitrate / 1_000_000;
  return `${megabits % 1 === 0 ? megabits : megabits.toFixed(1)} Mbps`;
}

export function resolutionLabel(width: number | null, height: number | null): string {
  if (width === null || height === null) {
    return "Source";
  }
  const known = RESOLUTION_CHOICES.find((choice) => choice.width === width && choice.height === height);
  return known !== undefined ? known.label : `${width}×${height}`;
}

/** The combo item text (oak): "Medium — 24 fps, 1080p, 3 Mbps". */
export function presetLabel(preset: SavedSharePreset): string {
  return `${preset.name} — ${preset.fps} fps, ${resolutionLabel(preset.width, preset.height)}, ${formatBitrate(preset.bitrate)}`;
}

/** The summary line (oak describeQuality): "24 fps · 1920×1080 · 3 Mbps". */
export function describeQuality(quality: ShareQuality): string {
  const resolution = quality.width !== null && quality.height !== null ? `${quality.width}×${quality.height}` : "source";
  return `${quality.fps} fps · ${resolution} · ${formatBitrate(quality.bitrate)}`;
}

/**
 * oak's upsert: trim, case-insensitive name match, newest wins, capped at
 * MAX_SHARE_PRESETS (the oldest entries fall off the front).
 */
export function upsertPreset(list: SavedSharePreset[], name: string, quality: ShareQuality): SavedSharePreset[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return list;
  }
  const lowered = trimmed.toLowerCase();
  const without = list.filter((preset) => preset.name.toLowerCase() !== lowered);
  // Explicit fields, NOT a spread: a quality carrying a leaked preset `name`
  // must never override the name being saved.
  const record: SavedSharePreset = {
    name: trimmed,
    fps: quality.fps,
    width: quality.width,
    height: quality.height,
    bitrate: quality.bitrate,
  };
  const next = [...without, record];
  return next.slice(Math.max(0, next.length - MAX_SHARE_PRESETS));
}

/**
 * getDisplayMedia constraints for a screen/window share: max-semantics —
 * Chromium downscales a bigger source and never upscales a smaller one;
 * "Source" only bounds the frame rate.
 */
export function displayVideoConstraints(quality: ShareQuality): MediaTrackConstraints {
  return {
    frameRate: { max: quality.fps },
    ...(quality.width !== null && quality.height !== null
      ? { width: { max: quality.width }, height: { max: quality.height } }
      : {}),
  };
}

/**
 * Camera constraints: ideal-semantics — the device picks its closest
 * capability (oak's closestCapability analogue); "Source" leaves the
 * resolution to the device entirely.
 */
export function cameraVideoConstraints(quality: ShareQuality): MediaTrackConstraints {
  return {
    frameRate: { max: quality.fps },
    ...(quality.width !== null && quality.height !== null
      ? { width: { ideal: quality.width }, height: { ideal: quality.height } }
      : {}),
  };
}
