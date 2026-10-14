/**
 * Progress text helpers for the provisioning steps (user decision 2026-10-15:
 * "percentages after the step name, before its description"). Upload progress
 * is a REAL byte counter (the SFTP transfer knows both numbers); the docker /
 * compose steps cannot compute percentages, so they surface the LAST OUTPUT
 * LINE of the running command instead — a moving line distinguishes "slow but
 * working" from "hung" without pretending to a number.
 */

/** "34.2 / 79.1 MB · 43%" — empty string for degenerate inputs (never NaN). */
export function formatByteProgress(bytesSent: number, bytesTotal: number): string {
  if (!Number.isFinite(bytesSent) || !Number.isFinite(bytesTotal) || bytesTotal <= 0 || bytesSent < 0) {
    return "";
  }
  const megabytes = (value: number): string => (value / (1024 * 1024)).toFixed(1);
  const percent = Math.min(100, Math.floor((bytesSent / bytesTotal) * 100));
  return `${megabytes(bytesSent)} / ${megabytes(bytesTotal)} MB · ${percent}%`;
}

/** One clipped, single-line snippet of a command's output for the step row:
 *  collapses whitespace and keeps the head of the line (apt/compose lines are
 *  front-loaded: "Unpacking docker-ce (…)"). Empty input collapses to "". */
export function clipProgressLine(line: string, maxLength = 72): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}
