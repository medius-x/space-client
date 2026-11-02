import { log } from "../logging";
import { backupFileName, backupFilePrefix, backupStamp } from "../domain/logic/backup-files";
import type { ConnectionSession } from "../domain/session/connection-session";
import { connectionDirectory, settingsStore } from "./runtime";
import type { BackupDownloadOutcome } from "./bridges";

/**
 * The "take a backup" flows (backup round 2026-10-28), shared by the settings-screen
 * buttons and the client-side schedule: fire the server pass, poll it to completion, stream
 * the archive into the backup folder THROUGH THE MAIN PROCESS (the renderer never holds the
 * bytes). The Bearer token rides the IPC corridor — the authorization decision stays the
 * server's. The retention sweep runs in the SCHEDULE flow only (takeScheduledBackup) —
 * manual downloads save unconditionally (user decision 2026-10-28).
 *
 * <p>Download progress is NOT subscribed here: the settings screen owns the single
 * {@code spaceBackup.onProgress} listener slot and shows the stream; the schedule runs with
 * no UI and needs none.
 */

const BUILD_POLL_MILLIS = 2000;
/** A huge instance takes minutes, not seconds — but a wedged build must not hang the UI
 *  flow forever. Half an hour covers the far end of realistic archives. */
const BUILD_TIMEOUT_MILLIS = 30 * 60 * 1000;
/** "Not running, no last run" right after the 202 may mean the pass has not SURFACED yet
 *  (a server where the 202 body races the daemon thread's takeoff — the live-smoke bug of
 *  2026-10-28): keep polling for this long before declaring the run lost. */
const RUN_START_GRACE_MILLIS = 10_000;

export interface BackupFlowResult {
  ok: boolean;
  /** The local archive path after a successful download. */
  downloadedPath?: string;
  /** human-oriented failure reason on !ok. */
  error?: string;
  /** True when the flow stopped because the CALLER asked it to (the migration's
   *  backup step checks the flag between its phases) — not a failure to report. */
  cancelled?: boolean;
  /** The built archive's SHA-256 when the server reported one (the migration
   *  verifies the transferred/downloaded bytes against it). */
  archiveSha256?: string;
}

/** Asks the flow to stop at the next phase boundary (poll iterations, before the
 *  download starts) — the migration's Cancel while the backup step is live. */
export type BackupAbortCheck = () => boolean;

export async function takeBackupAndDownload(session: ConnectionSession): Promise<BackupFlowResult> {
  const built = await waitForBuiltBackup(session);
  if (!built.ok) {
    return built;
  }
  return await downloadBuiltBackup(session);
}

/** The SCHEDULE flow (user decision 2026-10-28): the retention sweep belongs to the
 *  AUTOMATIC download ONLY — a manual "Back up now"/"Download latest" saves the file
 *  unconditionally and never deletes anything from the folder. */
export async function takeScheduledBackup(session: ConnectionSession): Promise<BackupFlowResult> {
  const result = await takeBackupAndDownload(session);
  if (!result.ok) {
    return result;
  }
  await pruneBackupsOf(session);
  return result;
}

/** The MIGRATION flow's source archive (backup round 2026-10-28): a FRESH pass
 *  against the current server, downloaded to the OS TEMP dir — a ONE-SHOT file
 *  (user decision, same day): the download only starts as the first step of the
 *  migration run itself, and the archive is deleted when the run ends any way
 *  (success, failure, user cancel) — it never joins the retention set. */
export async function takeMigrationBackup(session: ConnectionSession,
                                          shouldAbort?: BackupAbortCheck): Promise<BackupFlowResult> {
  const built = await waitForBuiltBackup(session, shouldAbort);
  if (!built.ok) {
    return built;
  }
  if (shouldAbort?.() === true) {
    return { ok: false, error: "cancelled by the user", cancelled: true };
  }
  return await downloadMigrationArchive(session);
}

/** Downloads the ALREADY-BUILT archive into the OS temp dir as the migration's
 *  one-shot file — the fallback leg of the direct transfer (2026-11-02): the
 *  archive was taken moments ago, the pass is NOT re-fired, only the bytes
 *  travel through this computer. */
export async function downloadMigrationArchive(session: ConnectionSession): Promise<BackupFlowResult> {
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
 *  download flows). The optional abort check stops the flow between poll
 *  iterations (the migration's Cancel while its backup step is live). Exported
 *  for the migration source step (2026-11-02): the direct server-to-server
 *  leg needs the BUILT archive without downloading it. */
export async function waitForBuiltBackup(session: ConnectionSession,
                                         shouldAbort?: BackupAbortCheck): Promise<BackupFlowResult> {
  let status;
  try {
    status = await session.rest.runServerBackup();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
  const deadline = Date.now() + BUILD_TIMEOUT_MILLIS;
  const startGraceDeadline = Date.now() + RUN_START_GRACE_MILLIS;
  // Poll until the pass finishes. "Not running AND no latched report" means the run has
  // not surfaced yet (the 202 body may race the daemon thread's takeoff on servers that
  // assemble the response before the claim) — give it the grace window, don't give up on
  // the very first read. A latched report (success or failure) ends the loop immediately.
  while (status.running || status.lastRun === null) {
    if (shouldAbort?.() === true) {
      return { ok: false, error: "cancelled by the user", cancelled: true };
    }
    if (!status.running && status.lastRun === null && Date.now() > startGraceDeadline) {
      return { ok: false, error: "the server did not start the backup run" };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: "backup is still building — try downloading later" };
    }
    await delay(status.running ? BUILD_POLL_MILLIS : 1000);
    try {
      status = await session.rest.getBackupStatus();
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }
  const report = status.lastRun;
  if (report.error !== null) {
    return { ok: false, error: report.error };
  }
  return { ok: true, archiveSha256: report.archiveSha256 ?? undefined };
}

/** Downloads the archive the server has ALREADY built (the "Download latest"
 * button of the settings screen). Manual path (user decision 2026-10-28): the file
 * saves UNCONDITIONALLY — no retention sweep here, only the schedule prunes. */
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
  return { ok: true, downloadedPath: outcome.path };
}

/** Retention: keep the newest N archives of THIS server (the schedule-only sweep). */
async function pruneBackupsOf(session: ConnectionSession): Promise<void> {
  const record = connectionDirectory.get(session.recordId);
  const hostUrl = record?.hostUrl ?? "http://server";
  const keepCount = settingsStore.getSnapshot().backupKeepCount;
  try {
    await window.spaceBackup?.prune(backupFilePrefix(hostUrl), keepCount);
  } catch (error) {
    log.warn("backup", `retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
