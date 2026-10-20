/** Client self-update policy (user decisions 2026-10-20). The update itself is
 *  electron-updater in the MAIN process; these pure pieces decide WHEN a check
 *  may run and WHICH banner version survives the Skip button, so the scheduler
 *  in the renderer stays a thin shell (the repo rule: logic in pure functions).
 *
 *  The daily in-runtime check runs ONLY while the computer has been idle for
 *  UPDATE_IDLE_THRESHOLD_SECONDS — the same powerMonitor bridge the AFK sweep
 *  uses, but a much longer grace: an update probe must never compete with the
 *  user for attention. The startup check has NO idle gate (the banner is
 *  static — it interrupts nothing). */

/** 15 minutes of system-wide input idle before a scheduled check may fire. */
export const UPDATE_IDLE_THRESHOLD_SECONDS = 15 * 60;

/** How often the running client re-checks the feed (the startup check counts
 *  as one — the timer starts from it). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isIdleEnoughForUpdateCheck(idleSeconds: number): boolean {
  return idleSeconds >= UPDATE_IDLE_THRESHOLD_SECONDS;
}

export function isDailyCheckDue(lastCheckAt: number, now: number): boolean {
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** Whether the banner shows for a known newer version: Skip persists the exact
 *  version string, and the NEXT release (any other string) un-hides itself. */
export function shouldShowUpdateBanner(version: string | null, skippedVersion: string | null): boolean {
  return version !== null && version !== skippedVersion;
}

/** Numeric "a.b.c" comparison for the available-vs-current gate. electron-
 *  updater publishes plain semver in latest.yml; pre-release suffixes (never
 *  used by this project's releases) and garbage parse as NOT newer — the
 *  updater would not install a downgrade, and neither should the banner
 *  advertise one. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): number[] | null => {
    const parts = version.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const numbers: number[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        return null;
      }
      numbers.push(Number(part));
    }
    return numbers;
  };
  const candidateParts = parse(candidate);
  const currentParts = parse(current);
  if (candidateParts === null || currentParts === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart !== currentPart) {
      return candidatePart > currentPart;
    }
  }
  return false;
}
