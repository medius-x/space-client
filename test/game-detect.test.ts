/**
 * The IGDB game auto-detect verdict (game-detect.ts): the LIFO pick among
 * resolved games, the manual-rule override exclusion, and the Steam dossier's
 * pure parsers (appmanifest KeyValues, the steamapps/common path split).
 */
import { describe, expect, it } from "vitest";
import { pickAutoGameLine, isGameDetectCandidate, type GameResolution } from "../src/domain/logic/game-detect";
import { parseAppManifest, splitSteamPath } from "../electron/steam-games";
import type { GameCard } from "../src/types";

function card(igdbId: number, name: string): GameCard {
  return { igdbId, name, coverImageId: null, genres: [], firstReleaseDate: null };
}

describe("pickAutoGameLine", () => {
  it("picks the LATEST-detected resolved game and formats a playing line", () => {
    const resolutions = new Map<string, GameResolution>([
      ["witcher3.exe", { status: "resolved", card: card(1942, "The Witcher 3: Wild Hunt") }],
      ["eldenring.exe", { status: "resolved", card: card(1030, "ELDEN RING") }],
    ]);
    const stamps = new Map([["witcher3.exe", 100], ["eldenring.exe", 200]]);
    const line = pickAutoGameLine(["witcher3.exe", "eldenring.exe"], resolutions, stamps);
    expect(line).toEqual({ type: "playing", name: "ELDEN RING", igdbGameId: 1030 });
  });

  it("falls back to the still-running game when the newer one closes", () => {
    const resolutions = new Map<string, GameResolution>([
      ["witcher3.exe", { status: "resolved", card: card(1942, "The Witcher 3: Wild Hunt") }],
      ["eldenring.exe", { status: "resolved", card: card(1030, "ELDEN RING") }],
    ]);
    const line = pickAutoGameLine(["witcher3.exe"], resolutions, new Map());
    expect(line?.name).toBe("The Witcher 3: Wild Hunt");
  });

  it("ignores none/dismissed/unresolved exes and answers null when nothing resolves", () => {
    const resolutions = new Map<string, GameResolution>([
      ["a.exe", { status: "none" }],
      ["b.exe", { status: "dismissed" }],
    ]);
    expect(pickAutoGameLine(["a.exe", "b.exe"], resolutions)).toBeNull();
    expect(pickAutoGameLine(["c.exe"], resolutions)).toBeNull(); // never asked
  });

  it("keeps the first resolved exe on equal stamps (deterministic ties)", () => {
    const resolutions = new Map<string, GameResolution>([
      ["a.exe", { status: "resolved", card: card(1, "A") }],
      ["b.exe", { status: "resolved", card: card(2, "B") }],
    ]);
    const line = pickAutoGameLine(["a.exe", "b.exe"], resolutions, new Map());
    expect(line?.name).toBe("A");
  });
});

describe("isGameDetectCandidate", () => {
  it("only real applications without a manual rule participate", () => {
    const manual = new Set(["obs.exe"]);
    expect(isGameDetectCandidate("eldenring.exe", true, manual)).toBe(true);
    expect(isGameDetectCandidate("obs.exe", true, manual)).toBe(false); // explicit rule wins
    expect(isGameDetectCandidate("engine.exe", false, manual)).toBe(false); // a background process
  });
});

describe("parseAppManifest (Valve KeyValues)", () => {
  it("reads the appid and installdir", () => {
    const manifest = `
"AppState"
{
  "appid"    "   730"
  "name"     "Counter-Strike 2"
  "installdir"    "Counter-Strike Global Offensive"
  "LastUpdated"  "1700000000"
}`;
    expect(parseAppManifest(manifest)).toEqual({
      appId: "730",
      installDir: "Counter-Strike Global Offensive",
    });
  });

  it("answers null when either field is missing", () => {
    expect(parseAppManifest('"AppState" { "appid" "730" }')).toBeNull();
    expect(parseAppManifest("")).toBeNull();
  });
});

describe("splitSteamPath", () => {
  it("splits a Windows steamapps/common layout", () => {
    expect(splitSteamPath("C:\\Program Files (x86)\\Steam\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe"))
      .toEqual({ steamRoot: "C:\\Program Files (x86)\\Steam\\steamapps", gameFolder: "ELDEN RING" });
  });

  it("accepts a second library drive and POSIX separators", () => {
    expect(splitSteamPath("D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe"))
      .toEqual({ steamRoot: "D:\\SteamLibrary\\steamapps", gameFolder: "Cyberpunk 2077" });
  });

  it("rejects non-common steamapps dirs and non-Steam paths", () => {
    expect(splitSteamPath("C:\\Steam\\steamapps\\workshop\\content\\730\\x.exe")).toBeNull();
    expect(splitSteamPath("C:\\Steam\\steamapps\\common\\")).toBeNull(); // no game folder/exe below
    expect(splitSteamPath("C:\\Games\\Terraria\\Terraria.exe")).toBeNull();
  });
});
