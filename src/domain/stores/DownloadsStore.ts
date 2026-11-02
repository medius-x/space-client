import { Emitter } from "../lib/store";
import { kv } from "../persistence/kv-client";

/**
 * Which attachments have been saved to THIS computer (user request
 * 2026-11-03): after a download the save/open buttons flip from "Download"
 * to "Show in folder" for that attachment — everywhere it renders (file card,
 * lightbox, video modal), across restarts. App-wide, not per-connection:
 * a saved file belongs to the machine, and the attachment keys are globally
 * unique (attachments/<uuid>/…).
 *
 * The registry is deliberately tiny — one KV JSON file of
 * key → absolute path pairs (~300 bytes per downloaded file; a thousand
 * downloads ≈ 0.3 MB). Entries self-heal: when the file is gone from disk
 * (deleted, or the downloads folder was re-pointed elsewhere), the
 * "Show in folder" click resolves to "missing", the entry is dropped, and
 * the button falls back to "Download".
 */
const KV_KEY = "downloaded-files";

/** Key → the absolute path the file was saved to (including any " (N)"
 *  collision suffix the save may have added — the exact on-disk name). */
export type DownloadsSnapshot = Record<string, string>;

function sanitizeEntries(raw: unknown): DownloadsSnapshot {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const clean: DownloadsSnapshot = {};
  for (const [attachmentKey, savedPath] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof savedPath === "string" && savedPath.length > 0) {
      clean[attachmentKey] = savedPath;
    }
  }
  return clean;
}

export class DownloadsStore extends Emitter {
  private entries: DownloadsSnapshot = {};
  private loaded = false;

  getSnapshot = (): DownloadsSnapshot => this.entries;

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    this.entries = sanitizeEntries(await kv.get<unknown>(KV_KEY));
    this.loaded = true;
    this.emit();
  }

  /** The saved file's path, or null while the attachment is not known to be
   *  on this disk (never downloaded, or self-healed away). */
  pathFor(attachmentKey: string): string | null {
    return this.entries[attachmentKey] ?? null;
  }

  /** The download just landed — remember where, for this app run and beyond. */
  markDownloaded(attachmentKey: string, savedPath: string): void {
    if (this.entries[attachmentKey] === savedPath) {
      return;
    }
    this.entries = { ...this.entries, [attachmentKey]: savedPath };
    this.emit();
    void kv.set(KV_KEY, this.entries);
  }

  /** The remembered file is gone from disk — the button falls back to
   *  "Download" for this attachment again. */
  forget(attachmentKey: string): void {
    if (this.entries[attachmentKey] === undefined) {
      return;
    }
    const next = { ...this.entries };
    delete next[attachmentKey];
    this.entries = next;
    this.emit();
    void kv.set(KV_KEY, this.entries);
  }
}
