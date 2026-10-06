import { zipSync } from "fflate";
import { log } from "../logging";

/**
 * "Download client logs" (logging round, 2026-10-06): the main process flushes its ordered
 * write chain and hands over the retention-window bucket files (logs/space-YYYYMMDD-HH.log);
 * here they are zipped (DEFLATE — plain text compresses well; the expression packs use
 * STORE because their payloads are already compressed) and offered through the OS save
 * dialog. Mirrors the expression-pack export's cancel-vs-failure contract: a dismissed
 * dialog is NOT an error.
 */

/** One bucket file of the client log, collected by the main process. */
export interface CollectedLogFile {
  name: string;
  bytes: Uint8Array;
}

interface LogsBridge {
  collect(): Promise<CollectedLogFile[] | null>;
}

declare global {
  interface Window {
    spaceLogs?: LogsBridge;
  }
}

export type ClientLogsDownloadResult = "saved" | "canceled" | "failed";

export async function downloadClientLogs(): Promise<ClientLogsDownloadResult> {
  try {
    const files = await window.spaceLogs?.collect();
    if (!files || files.length === 0) {
      log.warn("logs", "client log collect returned no files");
      return "failed";
    }
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
      entries[file.name] = file.bytes;
    }
    const archive = zipSync(entries, { level: 6 });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const savedPath = await window.spaceMedia?.saveFile(`client-logs-${stamp}.zip`, archive);
    if (savedPath == null || savedPath === undefined) {
      return "canceled";
    }
    log.info("logs", `client logs exported: ${files.length} file(s), ${archive.byteLength} bytes → ${String(savedPath)}`);
    return "saved";
  } catch (error: unknown) {
    log.warn("logs", `client log export failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
