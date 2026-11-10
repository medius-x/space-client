import { describe, expect, it } from "vitest";
import type { SavedSharePreset, ShareQuality } from "../src/domain/logic/share-quality";
import {
  MAX_WINDOW_QUALITY_MEMORIES,
  rememberedWindowQuality,
  restorePreset,
  sanitizeRememberedSelection,
  sanitizeShareQuality,
  sanitizeWindowShareQualities,
  upsertWindowShareQuality,
  type RememberedShareSelection,
} from "../src/domain/logic/share-preset-memory";

const quality: ShareQuality = { fps: 24, width: 1920, height: 1080, bitrate: 3_000_000 };
const sourceQuality: ShareQuality = { fps: 60, width: null, height: null, bitrate: 12_000_000 };
const presets: readonly SavedSharePreset[] = [
  { name: "Medium", ...quality }, // a builtin with the SAME values as the custom one below
  { name: "Gaming", fps: 60, width: 2560, height: 1440, bitrate: 8_000_000 },
];

describe("upsertWindowShareQuality (per-title memory)", () => {
  it("remembers and refreshes a title (re-insertion = newest)", () => {
    let memories = upsertWindowShareQuality({}, "terminal — zsh", { quality, presetName: null });
    expect(rememberedWindowQuality(memories, "terminal — zsh")).toEqual({ quality, presetName: null });
    memories = upsertWindowShareQuality(memories, "terminal — zsh", { quality: sourceQuality, presetName: "Gaming" });
    expect(rememberedWindowQuality(memories, "terminal — zsh")).toEqual({ quality: sourceQuality, presetName: "Gaming" });
  });

  it("titles are matched EXACTLY (window titles are case-sensitive artifacts)", () => {
    const memories = upsertWindowShareQuality({}, "Terminal — zsh", { quality, presetName: null });
    expect(rememberedWindowQuality(memories, "terminal — zsh")).toBeNull();
    expect(rememberedWindowQuality(memories, "Terminal — zsh")).toEqual({ quality, presetName: null });
  });

  it("caps at the newest MAX titles — the oldest insertion falls off", () => {
    let memories: Record<string, RememberedShareSelection> = {};
    for (let index = 1; index <= MAX_WINDOW_QUALITY_MEMORIES + 2; index += 1) {
      memories = upsertWindowShareQuality(memories, `window ${index}`, {
        quality: { ...quality, fps: index },
        presetName: null,
      });
    }
    expect(Object.keys(memories)).toHaveLength(MAX_WINDOW_QUALITY_MEMORIES);
    expect(rememberedWindowQuality(memories, "window 1")).toBeNull(); // fell off
    expect(rememberedWindowQuality(memories, "window 2")).toBeNull(); // fell off
    expect(rememberedWindowQuality(memories, "window 3")).toEqual({ quality: { ...quality, fps: 3 }, presetName: null });
    expect(rememberedWindowQuality(memories, `window ${MAX_WINDOW_QUALITY_MEMORIES + 2}`)).toEqual({
      quality: { ...quality, fps: MAX_WINDOW_QUALITY_MEMORIES + 2 },
      presetName: null,
    });
  });

  it("a titleless window is never remembered (it cannot be re-matched)", () => {
    const memories = upsertWindowShareQuality({}, "   ", { quality, presetName: null });
    expect(Object.keys(memories)).toHaveLength(0);
  });
});

describe("restorePreset (the combo row a memory re-opens)", () => {
  it("the remembered NAME wins over an earlier preset with the same values", () => {
    // "Medium" (first in the list) has the same numbers — but the share rode
    // a DIFFERENT preset with those values; its row must come back.
    const remembered: RememberedShareSelection = { quality, presetName: "Мой сетап" };
    const list = [{ name: "Мой сетап", ...quality }, ...presets];
    expect(restorePreset(remembered, list)?.name).toBe("Мой сетап");
  });

  it("a deleted or re-saved-with-other-values name falls back to value matching", () => {
    const remembered: RememberedShareSelection = { quality, presetName: "Gone" };
    expect(restorePreset(remembered, presets)?.name).toBe("Medium"); // value match
  });

  it("a Custom memory (no name) restores by values only, Custom when nothing matches", () => {
    expect(restorePreset({ quality, presetName: null }, presets)?.name).toBe("Medium");
    expect(restorePreset({ quality: sourceQuality, presetName: null }, presets)).toBeNull();
    expect(restorePreset(null, presets)).toBeNull();
  });
});

describe("sanitizeShareQuality", () => {
  it("accepts a real quality, including the Source variant", () => {
    expect(sanitizeShareQuality(quality)).toEqual(quality);
    expect(sanitizeShareQuality(sourceQuality)).toEqual(sourceQuality);
  });

  it("rejects garbage from hand-edited KV", () => {
    expect(sanitizeShareQuality(null)).toBeNull();
    expect(sanitizeShareQuality("Medium")).toBeNull();
    expect(sanitizeShareQuality({ fps: "24", width: 1920, height: 1080, bitrate: 3 })).toBeNull();
    expect(sanitizeShareQuality({ fps: -1, width: 1920, height: 1080, bitrate: 3 })).toBeNull();
    // width without height (a half-"Source") is incoherent
    expect(sanitizeShareQuality({ fps: 24, width: 1920, height: null, bitrate: 3 })).toBeNull();
  });
});

describe("sanitizeRememberedSelection / sanitizeWindowShareQualities", () => {
  it("keeps quality and name, tolerates a missing name", () => {
    expect(sanitizeRememberedSelection({ quality, presetName: "Gaming" })).toEqual({ quality, presetName: "Gaming" });
    expect(sanitizeRememberedSelection({ quality })).toEqual({ quality, presetName: null });
    expect(sanitizeRememberedSelection({ quality: "fast" })).toBeNull();
  });

  it("drops garbage map entries, keeps valid ones", () => {
    const raw: Record<string, unknown> = {
      "terminal — zsh": { quality, presetName: "Gaming" },
      "broken window": { quality: { fps: "fast" } },
      "   ": { quality }, // whitespace-only key — could never be re-matched
    };
    const sanitized = sanitizeWindowShareQualities(raw);
    expect(Object.keys(sanitized)).toEqual(["terminal — zsh"]);
    expect(sanitized["terminal — zsh"]).toEqual({ quality, presetName: "Gaming" });
  });

  it("non-object KV becomes an empty memory", () => {
    expect(sanitizeWindowShareQualities(null)).toEqual({});
    expect(sanitizeWindowShareQualities(["a", "b"])).toEqual({});
  });
});
