import { Emitter } from "../domain/lib/store";
import type { RestClient } from "../core/rest";
import { log } from "../logging";

/**
 * Image cache keyed by the STABLE MinIO key (the presigned URL re-signs on every
 * fetch, so the browser's HTTP cache is useless). Three levels: in-memory
 * objectURL LRU → main-process disk cache (IPC) → network, with a fresh-link
 * recovery step (GET /api/attachments/link) when a fetched URL has aged out.
 * In-flight requests dedup by key — a re-render storm subscribes to ONE flight.
 */

interface MediaBridge {
  cachePut(key: string, bytes: Uint8Array): Promise<unknown>;
  cacheGet(key: string): Promise<unknown>;
  cacheTrim(maxBytes: number): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  saveFile(fileName: string, bytes: Uint8Array): Promise<unknown>;
}

declare global {
  interface Window {
    spaceMedia?: MediaBridge;
  }
}

const MEMORY_CAP = 32;

export interface CacheableImage {
  key: string;
  /** null = disk-only attempt (e.g. an inactive server's icon: only its own
   *  session could mint a presigned URL, and it is not the live one). */
  url: string | null;
}

export class AttachmentCache extends Emitter {
  private readonly memory = new Map<string, string>(); // key → objectURL, LRU by insertion
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly rest: () => RestClient | null;
  /** Disk budget in bytes; 0 = memory-only (client settings, M7). */
  private diskBudgetBytes = 256 * 1024 * 1024;

  constructor(rest: () => RestClient | null) {
    super();
    this.rest = rest;
  }

  /** Instant-apply disk budget; 0 also purges whatever is already on disk. */
  setDiskBudget(bytes: number): void {
    this.diskBudgetBytes = Math.max(0, bytes);
    void this.trimDisk();
  }

  getSnapshot = (): ReadonlyMap<string, string> => this.memory;

  /** Instant value for the first paint (no flash of empty tiles). */
  peek(key: string): string | null {
    const hit = this.memory.get(key) ?? null;
    if (hit !== null) {
      this.memory.delete(key);
      this.memory.set(key, hit); // recency bump
    }
    return hit;
  }

  loadImage(image: CacheableImage): Promise<string | null> {
    const hit = this.peek(image.key);
    if (hit !== null) {
      return Promise.resolve(hit);
    }
    const existing = this.inFlight.get(image.key);
    if (existing !== undefined) {
      return existing;
    }
    const job = this.doLoad(image).finally(() => {
      this.inFlight.delete(image.key);
    });
    this.inFlight.set(image.key, job);
    return job;
  }

  private async doLoad(image: CacheableImage): Promise<string | null> {
    const diskBytes = await this.readDisk(image.key);
    if (diskBytes !== null) {
      return this.remember(image.key, diskBytes);
    }

    let url = image.url;
    if (url !== null) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            void this.writeDisk(image.key, bytes);
            return this.remember(image.key, bytes);
          }
          if (response.status === 404) {
            return null; // the object is gone for good
          }
        } catch {
          // network error — fall through to the recovery mint
        }
        const client = this.rest();
        if (client === null) {
          return null;
        }
        const fresh = await client.freshAttachmentLink(image.key).catch(() => null);
        if (fresh === null || fresh === undefined) {
          return null;
        }
        url = fresh;
      }
    }
    return null;
  }

  private remember(key: string, bytes: Uint8Array): string {
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
    this.memory.set(key, objectUrl);
    while (this.memory.size > MEMORY_CAP) {
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const evicted = this.memory.get(oldestKey);
      this.memory.delete(oldestKey);
      if (evicted !== undefined) {
        URL.revokeObjectURL(evicted);
      }
    }
    this.emit();
    return objectUrl;
  }

  private async readDisk(key: string): Promise<Uint8Array | null> {
    if (this.diskBudgetBytes === 0) {
      return null; // memory-only mode — the disk layer is switched off
    }
    const bridge = typeof window !== "undefined" ? window.spaceMedia : undefined;
    if (!bridge) {
      return null;
    }
    try {
      const bytes = (await bridge.cacheGet(key)) as Uint8Array | null;
      return bytes instanceof Uint8Array ? bytes : null;
    } catch {
      return null;
    }
  }

  private async writeDisk(key: string, bytes: Uint8Array): Promise<void> {
    if (this.diskBudgetBytes === 0) {
      return;
    }
    const bridge = typeof window !== "undefined" ? window.spaceMedia : undefined;
    if (!bridge) {
      return;
    }
    try {
      await bridge.cachePut(key, bytes);
      await this.trimDisk();
    } catch (error) {
      log.warn("cache", `disk write for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async trimDisk(): Promise<void> {
    const bridge = typeof window !== "undefined" ? window.spaceMedia : undefined;
    if (!bridge) {
      return;
    }
    try {
      await bridge.cacheTrim(this.diskBudgetBytes);
    } catch {
      // trimming is best-effort
    }
  }
}
