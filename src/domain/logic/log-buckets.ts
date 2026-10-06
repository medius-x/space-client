/**
 * Client-log retention math (logging round, 2026-10-06): the log lives in HOURLY bucket files
 * {@code space-YYYYMMDD-HH.log} under {@code userData/logs/}, in UTC — the log lines themselves
 * carry ISO-UTC timestamps, so the bucket name and the lines inside it agree. Buckets older
 * than 24 hours are deleted (a sliding window, not calendar days) so the file set never grows
 * unbounded. Pure functions — the main process and the unit tests share them.
 */

/** One hour of bucket lifetime per file. */
const BUCKET_MS = 60 * 60 * 1000;

/** How long a bucket survives: a sliding 24-hour window. */
export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

const BUCKET_PATTERN = /^space-(\d{4})(\d{2})(\d{2})-(\d{2})\.log$/;

/** Pads a number to two digits (hours and date components are always ≤ 2 digits here). */
function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/** The bucket file name for the given moment: {@code space-20261007-03.log} (UTC hour). */
export function logBucketName(date: Date): string {
  return `space-${date.getUTCFullYear()}${padTwo(date.getUTCMonth() + 1)}${padTwo(date.getUTCDate())}-${padTwo(date.getUTCHours())}.log`;
}

/**
 * The bucket's start moment parsed back from its file name, or null for anything that is not
 * a bucket (foreign files in the directory are left alone by the cleanup).
 */
export function parseLogBucketMillis(fileName: string): number | null {
  const match = BUCKET_PATTERN.exec(fileName);
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour] = match;
  const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour));
  // A well-formed name always round-trips — the guard is for hand-crafted 20261399-99 names.
  if (logBucketName(new Date(parsed)) !== fileName) {
    return null;
  }
  return parsed;
}

/** Bucket files whose start moment fell out of the retention window at {@code now}. */
export function outdatedLogBucketNames(fileNames: readonly string[], now: Date): string[] {
  return fileNames.filter((fileName) => {
    const startedAt = parseLogBucketMillis(fileName);
    return startedAt !== null && now.getTime() - startedAt >= LOG_RETENTION_MS;
  });
}
