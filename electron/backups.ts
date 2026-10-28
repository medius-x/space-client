import { dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { backupFilesToPrune } from "../src/domain/logic/backup-files";

/**
 * Server-backup downloads (backup round, 2026-10-28): the archive the server builds may be
 * gigabytes, so the MAIN process streams it straight to disk — the renderer's downloadBytes
 * would buffer the whole thing as an ArrayBuffer in its heap, and its 120 s timeout cannot
 * carry a slow link. The Bearer token rides IPC: a local corridor of one application (the
 * same token already lives in both processes' memory), and the authorization decision is
 * still the server's, made from that principal.
 *
 * <p>Files land in the BACKUP folder — {@code <OS Downloads>/SPACE/backup} by default, or
 * the user-configured absolute folder (a client setting this module reads from the same KV
 * store as {@code downloadsFolder}). File names are basenames and the folder is never taken
 * from the caller: a hostile renderer cannot steer the write anywhere else. Collisions get
 * " (N)" suffixes like every other save.
 *
 * <p>Retention: {@code space-backup:prune} keeps the newest N files of ONE server (the
 * caller passes the {@code server-backup-<host>-} prefix; slashes and dots are refused so a
 * prefix can never walk paths) — both the schedule and the button prune, because the button
 * auto-downloads too (the trigger is the only difference between them).
 */

export interface BackupDownloadProgress {
  fileName: string;
  receivedBytes: number;
  totalBytes: number | null;
}

export type BackupDownloadResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: string };

export interface BackupsIpcDeps {
  /** Push download progress to the main window's renderer (throttled to ~4 Hz). */
  emit(event: BackupDownloadProgress): void;
  /** The main-process file log (space.log); the caller adds the module prefix. */
  log(line: string): void;
  /** KV read of "client-settings" (the backup folder override lives there). */
  kvRead(key: string): unknown;
  /** The OS Downloads root ({@code app.getPath("downloads")}). */
  downloadsRoot(): string;
  /** The OS temp root ({@code app.getPath("temp")}) — the migration one-shot. */
  tempRoot(): string;
}

const DOWNLOADS_FOLDER_NAME = "SPACE"; // mirrors main.ts — separate module, one constant
const BACKUP_SUBFOLDER = "backup";
const PROGRESS_EMIT_BYTES = 256 * 1024;

function sanitizeFolderSetting(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || !path.isAbsolute(raw)) {
    return null;
  }
  return path.normalize(raw);
}

function resolveBackupDir(deps: BackupsIpcDeps): string {
  const settings = deps.kvRead("client-settings");
  const configured = settings !== null && typeof settings === "object"
    ? sanitizeFolderSetting((settings as Record<string, unknown>).backupFolder)
    : null;
  const dir = configured
    ?? path.join(deps.downloadsRoot(), DOWNLOADS_FOLDER_NAME, BACKUP_SUBFOLDER);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    deps.log(`backup dir "${dir}" create failed: ${error instanceof Error ? error.message : String(error)} — falling back to the OS Downloads root`);
    return deps.downloadsRoot();
  }
}

function uniqueBackupPath(dir: string, fileName: string): string {
  const extension = path.extname(fileName);
  const base = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;
  let candidate = path.join(dir, fileName);
  for (let copy = 1; copy < 100; copy += 1) {
    try {
      fs.accessSync(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${base} (${copy})${extension}`);
  }
  return path.join(dir, `${base} (${Date.now()})${extension}`);
}

/** A retention prefix is a file-name fragment only: no separators, no parent walks. */
function sanitizePrefix(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 120) {
    return null;
  }
  return /^[\w.-]+$/.test(raw) ? raw : null;
}

export function installBackupIpc(deps: BackupsIpcDeps): void {
  const log = (line: string): void => deps.log(`[backup] ${line}`);

  ipcMain.handle("space-backup:info", () => {
    const settings = deps.kvRead("client-settings");
    const configured = settings !== null && typeof settings === "object"
      ? sanitizeFolderSetting((settings as Record<string, unknown>).backupFolder)
      : null;
    return { folder: resolveBackupDir(deps), configured };
  });

  ipcMain.handle("space-backup:chooseFolder", async () => {
    const chosen = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths[0] ?? null;
  });

  ipcMain.handle("space-backup:chooseArchive", async () => {
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Server backup", extensions: ["zip"] }],
    });
    return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths[0] ?? null;
  });

  ipcMain.handle("space-backup:openFolder", () => {
    const dir = resolveBackupDir(deps);
    void shell.openPath(dir);
    return dir;
  });

  ipcMain.handle("space-backup:download", async (_event, url: unknown, fileName: unknown, bearer: unknown, target: unknown)
      : Promise<BackupDownloadResult> => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)
        || typeof fileName !== "string" || typeof bearer !== "string" || bearer.length === 0) {
      return { ok: false, error: "invalid arguments" };
    }
    const safeName = path.basename(fileName).trim() || "server-backup.zip";
    // "temp" serves the MIGRATION flow: the archive rides straight to the new
    // machine through the provisioning upload and is deleted afterwards — it
    // never joins the retention set of the backup folder.
    const tempDir = path.join(deps.tempRoot(), "space-migrate");
    const dir = target === "temp" ? (() => {
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        return tempDir;
      } catch {
        return deps.tempRoot();
      }
    })() : resolveBackupDir(deps);
    const destination = target === "temp" ? path.join(dir, safeName) : uniqueBackupPath(dir, safeName);
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`download request failed: ${message}`);
      return { ok: false, error: message };
    }
    if (!response.ok || response.body === null) {
      log(`download failed: HTTP ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const totalBytes = Number(response.headers.get("content-length")) || null;
    let receivedBytes = 0;
    let nextEmitAt = PROGRESS_EMIT_BYTES;
    try {
      const writer = fs.createWriteStream(destination);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          receivedBytes += value.byteLength;
          writer.write(Buffer.from(value));
        }
        if (receivedBytes >= nextEmitAt) {
          nextEmitAt = receivedBytes + PROGRESS_EMIT_BYTES;
          deps.emit({ fileName: safeName, receivedBytes, totalBytes });
        }
      }
      await new Promise<void>((resolve, reject) => {
        writer.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      deps.emit({ fileName: safeName, receivedBytes, totalBytes });
      log(`downloaded "${safeName}" (${receivedBytes} bytes) → ${destination}`);
      return { ok: true, path: destination, bytes: receivedBytes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`download of "${safeName}" failed: ${message}`);
      void fsp.rm(destination, { force: true }).catch(() => undefined); // no half-written archives
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("space-backup:prune", async (_event, prefix: unknown, keepCount: unknown)
      : Promise<string[]> => {
    const safePrefix = sanitizePrefix(prefix);
    const keep = typeof keepCount === "number" && Number.isFinite(keepCount) ? Math.round(keepCount) : 1;
    if (safePrefix === null) {
      return [];
    }
    const dir = resolveBackupDir(deps);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return []; // no folder yet — nothing to prune
    }
    const doomed = backupFilesToPrune(names, safePrefix, keep);
    for (const name of doomed) {
      try {
        await fsp.rm(path.join(dir, name), { force: true });
      } catch (error) {
        log(`prune could not delete "${name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (doomed.length > 0) {
      log(`pruned ${doomed.length} old backup(s) of "${safePrefix}" (keeping ${keep})`);
    }
    return doomed;
  });
}
