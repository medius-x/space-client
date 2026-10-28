import { log } from "../logging";
import { sessionBinding, settingsStore } from "./runtime";
import { takeBackupAndDownload } from "./backup-run";

/**
 * The CLIENT-side periodic backup (backup round 2026-10-28 — user decision: the schedule
 * lives on the client, the server stores nothing). A one-minute tick checks the ACTIVE
 * session's record against its configured time; the pass fires only while the client runs
 * — there is deliberately NO catch-up for the minutes the client was off.
 *
 * <p>The day is latched in memory (a restart within the same minute re-fires at most once
 * more — harmless, the server keeps a single archive slot).
 */

const TICK_MILLIS = 60_000;

/** recordId → ISO date of the last fired scheduled backup. */
const firedOn = new Map<string, string>();

let ticking = false;

export function startBackupScheduleTicking(): void {
  if (ticking) {
    return;
  }
  ticking = true;
  window.setInterval(() => void fireIfDue(), TICK_MILLIS);
}

async function fireIfDue(): Promise<void> {
  const session = sessionBinding.getSnapshot();
  if (session === null) {
    return;
  }
  const schedule = settingsStore.getSnapshot().backupSchedules[session.recordId];
  if (schedule === undefined || !schedule.enabled) {
    return;
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (firedOn.get(session.recordId) === today) {
    return;
  }
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  if (nowMinute !== schedule.minuteOfDay) {
    return;
  }
  firedOn.set(session.recordId, today);
  log.info("backup", `scheduled pass for ${session.recordId} at ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const result = await takeBackupAndDownload(session);
  if (result.ok) {
    log.info("backup", `scheduled backup saved → ${result.downloadedPath ?? "?"}`);
  } else {
    log.warn("backup", `scheduled backup failed: ${result.error ?? "unknown"}`);
  }
}
