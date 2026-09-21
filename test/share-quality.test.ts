import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESETS,
  BITRATE_CHOICES_MBPS,
  DEFAULT_PICKER_QUALITY,
  FPS_CHOICES,
  MAX_SHARE_PRESETS,
  cameraVideoConstraints,
  clampQualityToSource,
  describeQuality,
  displayVideoConstraints,
  feasibleResolutions,
  presetLabel,
  resolveQuality,
  upsertPreset,
  type ShareQuality,
} from "../src/domain/logic/share-quality";

const quality = (fps: number, width: number | null, height: number | null, bitrate: number): ShareQuality =>
  ({ fps, width, height, bitrate });

describe("feasibleResolutions", () => {
  it("offers everything for an unknown source (detection unavailable)", () => {
    expect(feasibleResolutions(null, null).map((choice) => choice.label))
      .toEqual(["Source", "720p", "1080p", "1440p", "2160p"]);
  });

  it("keeps Source always — a small window smaller than every preset still has a floor", () => {
    expect(feasibleResolutions(800, 600).map((choice) => choice.label)).toEqual(["Source"]);
  });

  it("cuts presets whose width OR height exceeds the source", () => {
    // 1366×768 laptop panel: 720p fits (1280≤1366, 720≤768), 1080p does not (1920>1366).
    expect(feasibleResolutions(1366, 768).map((choice) => choice.label)).toEqual(["Source", "720p"]);
    // 1920×1200: 1080p fits (1080≤1200), 1440p does not (1440>1200).
    expect(feasibleResolutions(1920, 1200).map((choice) => choice.label)).toEqual(["Source", "720p", "1080p"]);
  });

  it("keeps an exact 1080p source at exactly 1080p (boundary is inclusive)", () => {
    expect(feasibleResolutions(1920, 1080).map((choice) => choice.label)).toEqual(["Source", "720p", "1080p"]);
  });

  it("offers the full ladder for a 4K source", () => {
    expect(feasibleResolutions(3840, 2160).map((choice) => choice.label))
      .toEqual(["Source", "720p", "1080p", "1440p", "2160p"]);
  });
});

describe("clampQualityToSource", () => {
  it("keeps a feasible quality untouched", () => {
    const medium = DEFAULT_PICKER_QUALITY;
    expect(clampQualityToSource(medium, 2560, 1440)).toEqual(medium);
  });

  it("drops the default to the highest feasible preset resolution", () => {
    // Medium (1080p) on a 1366×768 panel → 720p, fps/bitrate stay Medium's.
    expect(clampQualityToSource(DEFAULT_PICKER_QUALITY, 1366, 768))
      .toEqual(quality(24, 1280, 720, 3_000_000));
  });

  it("falls to Source when no preset resolution fits at all", () => {
    expect(clampQualityToSource(DEFAULT_PICKER_QUALITY, 800, 600))
      .toEqual(quality(24, null, null, 3_000_000));
  });

  it("never clamps when the source size is unknown", () => {
    expect(clampQualityToSource(DEFAULT_PICKER_QUALITY, null, null)).toEqual(DEFAULT_PICKER_QUALITY);
  });
});

describe("resolveQuality (oak port)", () => {
  const segments = quality(60, 1280, 720, 8_000_000);
  const preset = quality(24, 1920, 1080, 3_000_000);

  it("a touched segment beats the selected preset", () => {
    expect(resolveQuality(true, preset, segments)).toEqual(segments);
  });

  it("without a touched segment the combo preset wins", () => {
    expect(resolveQuality(false, preset, segments)).toEqual(preset);
  });

  it("no preset selected (Custom) → the segments are the pick", () => {
    expect(resolveQuality(false, null, segments)).toEqual(segments);
  });

  it("strips a leaked preset name — the resolved quality is never a SavedSharePreset", () => {
    // Live bug: the combo value IS a preset object (structural subtype), and
    // the leaked `name` rode a spread into the saved record — saving "Gaming"
    // over the untouched Medium default produced a SECOND "Medium".
    const presetObject = { name: "Medium", ...quality(24, 1920, 1080, 3_000_000) };
    const resolved = resolveQuality(false, presetObject, segments);
    expect(resolved).toEqual(quality(24, 1920, 1080, 3_000_000));
    expect("name" in resolved).toBe(false);
  });
});

describe("labels", () => {
  it("describes a preset quality the oak way", () => {
    expect(describeQuality(quality(24, 1920, 1080, 3_000_000))).toBe("24 fps · 1920×1080 · 3 Mbps");
  });

  it("describes Source and fractional bitrates", () => {
    expect(describeQuality(quality(15, null, null, 1_500_000))).toBe("15 fps · source · 1.5 Mbps");
  });

  it("labels builtin presets for the combo", () => {
    expect(presetLabel(BUILTIN_PRESETS[1]!)).toBe("Medium — 24 fps, 1080p, 3 Mbps");
  });

  it("labels a custom resolution by its numbers", () => {
    expect(describeQuality(quality(30, 3440, 1440, 8_000_000))).toBe("30 fps · 3440×1440 · 8 Mbps");
  });
});

describe("upsertPreset", () => {
  it("appends a new preset", () => {
    const next = upsertPreset([], "Gaming", quality(60, 1920, 1080, 8_000_000));
    expect(next).toHaveLength(1);
    expect(next[0]!.name).toBe("Gaming");
  });

  it("replaces by case-insensitive name (newest wins)", () => {
    const first = upsertPreset([], "Gaming", quality(60, 1920, 1080, 8_000_000));
    const next = upsertPreset(first, "  gaming ", quality(30, 1920, 1080, 6_000_000));
    expect(next).toHaveLength(1);
    expect(next[0]!.bitrate).toBe(6_000_000);
    expect(next[0]!.name).toBe("gaming"); // trimmed, as typed the second time
  });

  it("ignores a blank name", () => {
    const list = upsertPreset([], "Gaming", quality(60, 1920, 1080, 8_000_000));
    expect(upsertPreset(list, "   ", quality(30, null, null, 3_000_000))).toBe(list);
  });

  it("keeps the GIVEN name when the quality carries a stale preset name", () => {
    const stale = { name: "Medium", ...quality(24, 1920, 1080, 3_000_000) };
    const next = upsertPreset([], "Gaming", stale);
    expect(next[0]!.name).toBe("Gaming");
    expect(next[0]!.fps).toBe(24);
  });

  it("caps the list at MAX_SHARE_PRESETS, dropping the oldest", () => {
    let list: ReturnType<typeof upsertPreset> = [];
    for (let index = 0; index < MAX_SHARE_PRESETS + 5; index += 1) {
      list = upsertPreset(list, `Preset ${index}`, quality(30, 1920, 1080, 3_000_000));
    }
    expect(list).toHaveLength(MAX_SHARE_PRESETS);
    expect(list[0]!.name).toBe("Preset 5"); // 0..4 fell off the front
    expect(list[list.length - 1]!.name).toBe(`Preset ${MAX_SHARE_PRESETS + 4}`);
  });
});

describe("capture constraints", () => {
  it("display constraints cap resolution and frame rate (max — never upscales)", () => {
    expect(displayVideoConstraints(quality(24, 1920, 1080, 3_000_000)))
      .toEqual({ frameRate: { max: 24 }, width: { max: 1920 }, height: { max: 1080 } });
  });

  it("Source display constraints bound only the frame rate", () => {
    expect(displayVideoConstraints(quality(30, null, null, 6_000_000)))
      .toEqual({ frameRate: { max: 30 } });
  });

  it("camera constraints use ideal semantics (closest device capability)", () => {
    expect(cameraVideoConstraints(quality(24, 1920, 1080, 3_000_000)))
      .toEqual({ frameRate: { max: 24 }, width: { ideal: 1920 }, height: { ideal: 1080 } });
    expect(cameraVideoConstraints(quality(24, null, null, 3_000_000)))
      .toEqual({ frameRate: { max: 24 } });
  });
});

describe("choice ladders (oak parity)", () => {
  it("matches oak's segment rows", () => {
    expect(FPS_CHOICES).toEqual([15, 24, 30, 45, 60, 75, 90]);
    expect(BITRATE_CHOICES_MBPS).toEqual([1.5, 3, 6, 8, 12, 16]);
  });

  it("the step-2 default is Medium (user decision, NOT oak's High)", () => {
    expect(DEFAULT_PICKER_QUALITY).toEqual(quality(24, 1920, 1080, 3_000_000));
  });
});
