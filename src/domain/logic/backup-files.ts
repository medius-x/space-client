/**
 * Backup file naming and retention (backup round, 2026-10-28) — pure logic shared by the
 * MAIN process (which owns the folder and the pruning sweep) and the renderer (which builds
 * the names and drives the schedule). No Electron imports: domain stays framework-free.
 *
 * <p>Names carry the server host and a sort-safe stamp ({@code yyyyMMdd-HHmmss} — ascending
 * lexicographic order IS ascending chronological order), which is what lets the retention
 * sweep delete "oldest beyond N" by a plain name sort.
 */

/** The stamp part of a backup file name: sortable, filesystem-safe, second-precision. */
export function backupStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** A hostname safe for a file-name prefix: hostnames already are. An IPv6 literal (colons
 *  are illegal in Windows file names) and anything exotic degrade to "server" — every such
 *  server's archives then share one retention prefix, which is still correct. */
export function backupHostToken(hostUrl: string): string {
  try {
    const host = new URL(hostUrl).hostname.replace(/^\[|\]$/g, "");
    return /^[A-Za-z0-9.-]+$/.test(host) ? host : "server";
  } catch {
    return "server";
  }
}

/** The retention prefix of one server's backups: {@code server-backup-<host>-}. */
export function backupFilePrefix(hostUrl: string): string {
  return `server-backup-${backupHostToken(hostUrl)}-`;
}

/** The full archive name: {@code server-backup-<host>-<stamp>.zip}. */
export function backupFileName(hostUrl: string, stamp: string): string {
  return `${backupFilePrefix(hostUrl)}${stamp}.zip`;
}

/** Which files a retention sweep must DELETE: all matches of the prefix sorted newest-first
 *  (the sort-safe stamp), everything past the first {@code keepCount} of them. Unrelated
 *  files in the folder are never the sweep's business. */
export function backupFilesToPrune(names: string[], prefix: string, keepCount: number): string[] {
  const matching = names.filter((name) => name.startsWith(prefix)).sort((left, right) => right.localeCompare(left));
  return matching.slice(Math.max(1, keepCount));
}

/** The retention bounds (the settings store sanitizes to this range too). */
export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 30;

export function clampBackupKeepCount(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 1;
  return Math.min(BACKUP_KEEP_MAX, Math.max(BACKUP_KEEP_MIN, value));
}
