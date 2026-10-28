import { log } from "../logging";
import { backupFileName, backupFilePrefix, backupStamp } from "../domain/logic/backup-files";
import type { ConnectionSession } from "../domain/session/connection-session";
import { connectionDirectory, settingsStore } from "./runtime";
import type { BackupDownloadOutcome } from "./bridges";

/**
 * The full "take a backup" flow (backup round 2026-10-28), shared by the settings-screen
 * button and the client-side schedule: fire the server pass, poll it to completion, stream
 * the archive into the backup folder THROUGH THE MAIN PROCESS (the renderer never holds the
 * bytes), then run the retention sweep. The Bearer token rides the IPC corridor — the
 * authorization decision stays the server's.
 *
 * <p>Download progress is NOT subscribed here: the settings screen owns the single
 * {@code spaceBackup.onProgress} listener slot and shows the stream; the schedule runs with
 * no UI and needs none.
 */

const BUILD_POLL_MILLIS = 2000;
/** A huge instance takes minutes, not seconds — but a wedged build must not hang the UI
 *  flow forever. Half an hour covers the far end of realistic archives. */
const BUILD_TIMEOUT_MILLIS = 30 * 60 * 1000;

export interface BackupFlowResult {
  ok: boolean;
  /** The local archive path after a successful download. */
  downloadedPath?: string;
  /** human-oriented failure reason on !ok. */
  error?: string;
}

export async function takeBackupAndDownload(session: ConnectionSession): Promise<BackupFlowResult> {
  const built = await waitForBuiltBackup(session);
  if (!built.ok) {
    return built;
  }
  return await downloadBuiltBackup(session);
}

/** The MIGRATION flow's source archive (backup round 2026-10-28): a FRESH pass
 *  against the current server, downloaded to the OS TEMP dir — a one-shot file
 *  that rides straight into the new machine's provisioning upload and is
 *  deleted afterwards; it never joins the retention set. */
export async function takeMigrationBackup(session: ConnectionSession): Promise<BackupFlowResult> {
  const built = await waitForBuiltBackup(session);
  if (!built.ok) {
    return built;
  }
  const record = connectionDirectory.get(session.recordId);
  const hostUrl = record?.hostUrl ?? "http://server";
  const bearer = session.rest.currentAccessToken();
  if (bearer === null || window.spaceBackup === undefined) {
    return { ok: false, error: "download bridge unavailable" };
  }
  const fileName = backupFileName(hostUrl, backupStamp(new Date()));
  const outcome: BackupDownloadOutcome = await window.spaceBackup.download(
    session.rest.backupFileUrl(), fileName, bearer, "temp");
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, downloadedPath: outcome.path };
}

/** Fires a backup pass and polls it to completion (the shared head of both
 *  download flows). */
async function waitForBuiltBackup(session: ConnectionSession): Promise<BackupFlowResult> {
  let status;
  try {
    status = await session.rest.runServerBackup();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
  // A pass may already have finished by the time the 202 body is read — poll regardless.
  const deadline = Date.now() + BUILD_TIMEOUT_MILLIS;
  while (status.running && Date.now() < deadline) {
    await delay(BUILD_POLL_MILLIS);
    try {
      status = await session.rest.getBackupStatus();
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }
  if (status.running) {
    return { ok: false, error: "backup is still building — try downloading later" };
  }
  const report = status.lastRun;
  if (report === null) {
    return { ok: false, error: "the server reported no backup run" };
  }
  if (report.error !== null) {
    return { ok: false, error: report.error };
  }
  return { ok: true };
}

/** Downloads the archive the server has ALREADY built (the "Download latest"
 * button of the settings screen) and runs the retention sweep. */
export async function downloadBuiltBackup(session: ConnectionSession): Promise<BackupFlowResult> {
  const record = connectionDirectory.get(session.recordId);
  const hostUrl = record?.hostUrl ?? "http://server";
  const bearer = session.rest.currentAccessToken();
  if (bearer === null || window.spaceBackup === undefined) {
    return { ok: false, error: "download bridge unavailable" };
  }
  const fileName = backupFileName(hostUrl, backupStamp(new Date()));
  const outcome: BackupDownloadOutcome = await window.spaceBackup.download(
    session.rest.backupFileUrl(), fileName, bearer);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  // Retention: keep the newest N archives of THIS server (both the button and the
  // schedule prune — the button auto-downloads too, the trigger is the only difference).
  const keepCount = settingsStore.getSnapshot().backupKeepCount;
  try {
    await window.spaceBackup.prune(backupFilePrefix(hostUrl), keepCount);
  } catch (error) {
    log.warn("backup", `retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, downloadedPath: outcome.path };
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, millis);
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
