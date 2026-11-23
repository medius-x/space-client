/**
 * The Steam dossier of the IGDB auto-detect (round 2, 2026-11-19): given a
 * running exe, the main process answers its GAME IDENTITY — the Steam appid
 * (the ladder's exact route) and the game folder name (usually the better
 * search candidate than the exe's glued name). Paths stay in MAIN (the
 * process-snapshot rule: only names cross to the renderer), so this walks the
 * same koffi QueryFullProcessImageNameW door and reads the Steam library's
 * appmanifest files itself.
 *
 * The exe PATH alone cannot give the appid: the folder name is not the appid.
 * The manifests are — {@code <Steam>\steamapps\appmanifest_<appid>.acf} carries
 * both the appid and the {@code installdir} (the folder under steamapps/common),
 * so one directory listing maps every installed game; the map is cached per
 * Steam root for the process lifetime (a freshly installed game re-reads on
 * the next restart — an acceptable staleness for a presence line).
 */
import { ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { appPidsByName, ensureBindings, processImagePath } from "./process-snapshot";
import type { GameIdentity } from "../src/types";

/** installdir (lowercased) → appid, cached per steamapps directory. */
const appIdsBySteamRoot = new Map<string, Map<string, string>>();

/** One parsed appmanifest — pure, unit-tested. Only the two fields the ladder
 *  needs; Valve's KeyValues format is quoted key/value pairs, and a regex read
 *  of the first occurrence is exactly what these files carry. */
export function parseAppManifest(text: string): { appId: string; installDir: string } | null {
  const appId = text.match(/"appid"\s+"\s*(\d+)\s*"/);
  const installDir = text.match(/"installdir"\s+"([^"]*)"/);
  const appIdValue = appId?.[1];
  const installDirValue = installDir?.[1];
  if (appIdValue === undefined || installDirValue === undefined) {
    return null;
  }
  return { appId: appIdValue, installDir: installDirValue };
}

/** Splits an exe path into its Steam parts — pure, unit-tested:
 *  {@code C:\Steam\steamapps\common\ELDEN RING\Game\eldenring.exe} →
 *  {@code {steamRoot: "C:\Steam\steamapps", gameFolder: "ELDEN RING"}};
 *  null for anything outside a {@code steamapps/common} layout. */
export function splitSteamPath(exePath: string): { steamRoot: string; gameFolder: string } | null {
  const segments = exePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const steamappsAt = segments.findIndex((segment) => segment.toLowerCase() === "steamapps");
  const commonSegment = steamappsAt >= 0 ? segments[steamappsAt + 1] : undefined;
  const gameFolder = steamappsAt >= 0 ? segments[steamappsAt + 2] : undefined;
  if (steamappsAt < 0 || commonSegment === undefined || gameFolder === undefined || gameFolder.length === 0) {
    return null; // no steamapps, or no game folder / no exe below common
  }
  if (commonSegment.toLowerCase() !== "common") {
    return null; // workshop/downloads/compatdata — never a game install
  }
  // Rejoin with the INPUT's separator, not path.sep (2026-11-23): the exe path
  // belongs to the OS the client runs on, and the reassembled root feeds
  // fs.readdirSync there — but the pure unit tests feed Windows paths on any
  // runner, and a Linux path.sep rejoin broke the CI (the local Windows gate
  // never saw it). A backslash anywhere in the input reads as Windows.
  const separator = exePath.includes("\\") ? "\\" : "/";
  return {
    steamRoot: segments.slice(0, steamappsAt + 1).join(separator),
    gameFolder,
  };
}

/** Reads (and caches) one Steam root's installdir → appid map. A read failure
 *  (permissions, a racing uninstall) degrades to an empty map — the dossier
 *  answers "no appid" rather than failing the whole detection. */
function appIdsForSteamRoot(steamRoot: string): Map<string, string> {
  const cached = appIdsBySteamRoot.get(steamRoot);
  if (cached !== undefined) {
    return cached;
  }
  const map = new Map<string, string>();
  try {
    for (const entry of fs.readdirSync(steamRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^appmanifest_.+\.acf$/i.test(entry.name)) {
        continue;
      }
      try {
        const parsed = parseAppManifest(fs.readFileSync(path.join(steamRoot, entry.name), "utf8"));
        if (parsed !== null) {
          map.set(parsed.installDir.toLowerCase(), parsed.appId);
        }
      } catch {
        // one unreadable manifest never blocks the rest
      }
    }
  } catch {
    // no directory access — an empty map answers "unknown"
  }
  appIdsBySteamRoot.set(steamRoot, map);
  return map;
}

/** The identity dossier by exe name (lowercased, the snapshot's convention). */
async function gameIdentity(exeName: string): Promise<GameIdentity | null> {
  const toolkits = ensureBindings();
  if (toolkits === null) {
    return null;
  }
  const pid = appPidsByName().get(exeName);
  if (pid === undefined) {
    return null; // the app closed between the tick and this ask — retried next tick
  }
  const exePath = processImagePath(toolkits, pid);
  if (exePath === null) {
    return null;
  }
  const steam = splitSteamPath(exePath);
  if (steam === null) {
    return { appId: null, folderName: null }; // a non-Steam app: the ladder falls back to the exe name
  }
  const appId = appIdsForSteamRoot(steam.steamRoot).get(steam.gameFolder.toLowerCase()) ?? null;
  return { appId, folderName: steam.gameFolder };
}

export function installSteamGamesIpc(): void {
  ipcMain.handle("space-processes:gameIdentity", async (_event, exeName: unknown): Promise<GameIdentity | null> => {
    if (typeof exeName !== "string" || exeName.length === 0 || exeName.length > 200) {
      return null;
    }
    return await gameIdentity(exeName);
  });
}
