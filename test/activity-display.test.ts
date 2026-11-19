/**
 * The activity-line renderer helpers: the IGDB game line's gamepad glyph and
 * the compact playtime formatter (whole hours once there is at least one,
 * minutes below that — the achievements are hour-shaped).
 */
import { describe, expect, it } from "vitest";
import { formatActivityLine, formatPlaytime, GAMEPAD_GLYPH } from "../src/renderer/activity-display";
import type { MessageKey, Translator } from "../src/domain/i18n/i18n";

/** A fake translator that just interpolates {count} — the format is under test,
 *  not the dictionaries. */
const t = ((key: MessageKey, params?: { count?: number }) =>
  key.replace("{count}", String(params?.count ?? ""))) as unknown as Translator;

describe("formatActivityLine", () => {
  it("a manual line keeps the localized verb prefix", () => {
    expect(formatActivityLine((key) => (key === "activity.playing" ? "Играет в" : key) as unknown as ReturnType<Translator>,
      { type: "playing", name: "CS2" })).toBe("Играет в CS2");
  });

  it("an IGDB game line carries the gamepad glyph instead of the verb", () => {
    expect(formatActivityLine(t, { type: "playing", name: "ELDEN RING", igdbGameId: 1030 }))
      .toBe(`${GAMEPAD_GLYPH} ELDEN RING`);
  });
});

describe("formatPlaytime", () => {
  it("renders whole hours once there is at least one", () => {
    expect(formatPlaytime(t, "settings.playtimeHours", "settings.playtimeMinutes", 45 * 3600))
      .toBe("settings.playtimeHours".replace("{count}", "45"));
    expect(formatPlaytime(t, "settings.playtimeHours", "settings.playtimeMinutes", 3600 + 3599))
      .toBe("settings.playtimeHours".replace("{count}", "1")); // truncated, not rounded
  });

  it("renders minutes below the first hour", () => {
    expect(formatPlaytime(t, "settings.playtimeHours", "settings.playtimeMinutes", 25 * 60))
      .toBe("settings.playtimeMinutes".replace("{count}", "25"));
    expect(formatPlaytime(t, "settings.playtimeHours", "settings.playtimeMinutes", 0))
      .toBe("settings.playtimeMinutes".replace("{count}", "0"));
  });
});
