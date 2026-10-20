import { app, ipcMain } from "electron";
import { autoUpdater, CancellationToken } from "electron-updater";
import { isNewerVersion } from "../src/domain/logic/update-policy";

/**
 * Client self-update (user decisions 2026-10-20): electron-updater against the
 * GitHub Releases of this repo, with EVERY download user-initiated
 * (autoDownload=false — no silent traffic) and the install fully automatic once
 * the user clicks Update (download → silent NSIS install → relaunch).
 *
 * The feed comes from resources/app-update.yml, which electron-builder emits
 * from the `publish` block in electron-builder.yml. There is no setFeedURL and
 * no token — the repo is public, so the renderer can never redirect the feed.
 *
 * Dev builds (app.isPackaged === false) answer "unsupported" everywhere and
 * never touch the updater — dev runs share userData with the packaged app.
 */

export interface UpdateCheckResult {
  status: "available" | "none" | "error" | "unsupported";
  version: string | null;
  message: string | null;
}

export type UpdateStateEvent =
  | { kind: "downloading"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

export interface UpdatesIpcDeps {
  /** Push a lifecycle event to the main window's renderer. */
  emit(event: UpdateStateEvent): void;
  /** The main-process file log (space.log), prefix added by the caller. */
  log(line: string): void;
}

let downloading = false;
let downloadToken: CancellationToken | null = null;
let downloadedVersion: string | null = null;
let lastLoggedPercent = -1;

export function installUpdateIpc(deps: UpdatesIpcDeps): void {
  const log = (line: string): void => deps.log(`[update] ${line}`);
  const emit = (event: UpdateStateEvent): void => deps.emit(event);

  autoUpdater.autoDownload = false; // every byte of traffic is user-initiated
  autoUpdater.autoInstallOnAppQuit = false; // installs happen only via quitAndInstall()

  // Progress events arrive in a hot stream — log at ~10% steps, emit every one.
  autoUpdater.on("download-progress", (progress) => {
    emit({
      kind: "downloading",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
    const step = Math.floor(progress.percent / 10) * 10;
    if (step !== lastLoggedPercent) {
      lastLoggedPercent = step;
      log(`download ${Math.round(progress.percent)}% (${Math.round(progress.bytesPerSecond / 1024)} KB/s)`);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloading = false;
    downloadedVersion = info.version;
    log(`downloaded v${info.version} — ready to install`);
    emit({ kind: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (error) => {
    downloading = false;
    const message = error instanceof Error ? error.message : String(error);
    log(`ERROR ${message}`);
    emit({ kind: "error", message });
  });

  const check = async (): Promise<UpdateCheckResult> => {
    if (!app.isPackaged) {
      return { status: "unsupported", version: null, message: null };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      const candidate = result.updateInfo.version;
      if (isNewerVersion(candidate, app.getVersion())) {
        log(`v${candidate} is available (current v${app.getVersion()})`);
        return { status: "available", version: candidate, message: null };
      }
      log(`checked — up to date (feed v${candidate})`);
      return { status: "none", version: null, message: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`check failed: ${message}`);
      return { status: "error", version: null, message };
    }
  };

  ipcMain.handle("space-updates:check", () => check());

  ipcMain.handle("space-updates:download", async (): Promise<{ started: boolean; reason: string | null }> => {
    if (!app.isPackaged) {
      return { started: false, reason: "not packaged" };
    }
    if (downloading) {
      return { started: false, reason: "already downloading" };
    }
    downloading = true;
    lastLoggedPercent = -1;
    downloadToken = new CancellationToken();
    log("download started");
    // The promise resolves on "update-downloaded" and rejects on error/cancel;
    // both sides already arrive as events above — this catch only keeps the
    // unhandled-rejection noise down for the cancel path.
    autoUpdater.downloadUpdate(downloadToken).catch(() => undefined);
    return { started: true, reason: null };
  });

  ipcMain.handle("space-updates:cancelDownload", () => {
    if (downloading && downloadToken !== null) {
      log("download canceled by the user");
      downloading = false;
      downloadToken.cancel();
      emit({ kind: "canceled" });
    }
  });

  ipcMain.on("space-updates:install", () => {
    if (downloadedVersion === null) {
      log("install requested with nothing downloaded — ignored");
      return;
    }
    log(`installing v${downloadedVersion} — quitting`);
    // isSilent + isForceRunAfter: the one-click NSIS installer runs quietly and
    // relaunches the app — the user never closes or reopens anything by hand.
    // The close-to-tray guard lets this through: before-quit sets the same
    // gracefulQuitStarted flag the tray Quit uses.
    autoUpdater.quitAndInstall(true, true);
  });
}
