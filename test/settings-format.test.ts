import { describe, expect, it } from "vitest";
import { advertisedAddress, diskCacheLabel, DISK_CACHE_CHOICES } from "../src/domain/logic/settings-format";

describe("diskCacheLabel (oak's Appearance → Images combo converter)", () => {
  it("0 is Off, sub-gigabyte values are MB, whole gigabytes are GB", () => {
    expect(diskCacheLabel(0)).toBe("Off");
    expect(diskCacheLabel(64)).toBe("64 MB");
    expect(diskCacheLabel(512)).toBe("512 MB");
    expect(diskCacheLabel(1024)).toBe("1 GB");
    expect(diskCacheLabel(2048)).toBe("2 GB");
    expect(diskCacheLabel(4096)).toBe("4 GB");
  });

  it("every offered choice has a distinct label", () => {
    const labels = DISK_CACHE_CHOICES.map((choice) => diskCacheLabel(choice));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("advertisedAddress (oak's Connections address)", () => {
  it("composes host:port from the server profile", () => {
    expect(advertisedAddress("oak.example.com", 8080)).toBe("oak.example.com:8080");
  });

  it("null when either part is missing (not set by the server)", () => {
    expect(advertisedAddress(null, 8080)).toBeNull();
    expect(advertisedAddress("oak.example.com", null)).toBeNull();
    expect(advertisedAddress("", 8080)).toBeNull();
    expect(advertisedAddress(null, null)).toBeNull();
  });
});

describe("noise suppression default (user decision 2026-10-15)", () => {
  it("DeepFilterNet3 is the default engine — the hint, the hotkey return target and fresh installs all follow it", async () => {
    const { DEFAULT_CLIENT_SETTINGS } = await import("../src/domain/stores/SettingsStore");
    expect(DEFAULT_CLIENT_SETTINGS.noiseSuppressionEngine).toBe("deepfilternet3");
  });
});
