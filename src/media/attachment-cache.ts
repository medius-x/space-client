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
  /** Downloads-folder controls (Diagnostics → Downloads). */
  downloadsInfo(): Promise<{ folder: string; configured: string | null } | null>;
  chooseDownloadsDir(): Promise<string | null>;
  openDownloadsDir(): Promise<string | null>;
}

declare global {
  interface Window {
    spaceMedia?: MediaBridge;
  }
}

const MEMORY_CAP = 32;
/** The session-less shared cache serves EVERY aggregated-list avatar (DM rows,
 *  friend rows) — its LRU headroom is larger than a per-session cache's. */
const DORMANT_MEMORY_CAP = 128;
/** A transient failure (network down, 5xx) only backs off for this long — it
 *  must not poison the cache for a whole offline minute. */
const TRANSIENT_BACKOFF_MS = 30_000;

export interface CacheableImage {
  key: string;
  /** null = disk-only attempt (e.g. an inactive server's icon: only its own
   *  session could mint a presigned URL, and it is not the live one). */
  url: string | null;
}

interface ActivityCounters {
  diskHits: number;
  diskMisses: number;
  fetches: number;
  fetchBytes: number;
  fetchWorstMs: number;
  deadSkips: number;
  backoffSkips: number;
}

function createEmptyActivity(): ActivityCounters {
  return { diskHits: 0, diskMisses: 0, fetches: 0, fetchBytes: 0, fetchWorstMs: 0, deadSkips: 0, backoffSkips: 0 };
}

export class AttachmentCache extends Emitter {
  private readonly memory = new Map<string, string>(); // key → objectURL, LRU by insertion
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly rest: () => RestClient | null;
  private readonly memoryCap: number;
  /** Session negative cache. The virtual list remounts rows on every scroll
   *  pass, and each remount of a DEAD object (404) used to re-run the whole
   *  disk→fetch→mint→fetch chain — the scroll freeze on attachment-heavy
   *  channels (live report 2026-09-25). A 404 verified against a freshly
   *  minted link kills the key for the session; transient failures (network,
   *  5xx) only get a short backoff instead. */
  private readonly deadKeys = new Set<string>();
  private readonly backoffUntil = new Map<string, number>();
  /** Disk budget in bytes; 0 = memory-only (client settings, M7). */
  private diskBudgetBytes = 256 * 1024 * 1024;
  /** Rolling activity window (diagnostics): what the cache actually did over
   *  the last flush interval — correlates scroll freezes with disk/fetch
   *  storms in space.log ([media] activity lines). */
  private activityCounters = createEmptyActivity();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rest: () => RestClient | null, memoryCap: number = MEMORY_CAP) {
    super();
    this.rest = rest;
    this.memoryCap = memoryCap;
  }

  /** Instant-apply disk budget; 0 also purges whatever is already on disk. */
  setDiskBudget(bytes: number): void {
    this.diskBudgetBytes = Math.max(0, bytes);
    void this.trimDisk();
  }

  /** Count something the cache did; arms the 5s flush that logs the window. */
  private noteActivity(record: (counters: ActivityCounters) => void): void {
    record(this.activityCounters);
    if (this.activityTimer === null) {
      this.activityTimer = setTimeout(() => this.flushActivity(), 5000);
    }
  }

  private flushActivity(): void {
    this.activityTimer = null;
    const counters = this.activityCounters;
    if (counters.diskHits + counters.diskMisses + counters.fetches + counters.deadSkips + counters.backoffSkips > 0) {
      log.warn(
        "media",
        `activity: ${counters.diskHits} disk hits, ${counters.diskMisses} disk misses, `
          + `${counters.fetches} fetches (${Math.round(counters.fetchBytes / 1024)}KB, worst ${counters.fetchWorstMs}ms), `
          + `${counters.deadSkips} dead-skips, ${counters.backoffSkips} backoff-skips`,
      );
    }
    this.activityCounters = createEmptyActivity();
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
    if (this.deadKeys.has(image.key)) {
      this.noteActivity((counters) => { counters.deadSkips += 1; });
      return null; // 404-verified this session — a stable placeholder, no traffic
    }
    const backoff = this.backoffUntil.get(image.key);
    if (backoff !== undefined && backoff > Date.now()) {
      this.noteActivity((counters) => { counters.backoffSkips += 1; });
      return null;
    }
    const diskBytes = await this.readDisk(image.key);
    if (diskBytes !== null) {
      this.noteActivity((counters) => { counters.diskHits += 1; });
      return this.remember(image.key, diskBytes);
    }
    this.noteActivity((counters) => { counters.diskMisses += 1; });

    let url = image.url;
    if (url === null) {
      // A disk-only row (an inactive record's icon before its profile
      // arrives): nothing to fetch and nothing to back off — the URL arrives
      // with the server profile and the directory update re-renders the rail.
      // Minting is NOT attempted: /attachments/link validates MESSAGE
      // attachments only, so a server-icon key mint-404s (live report
      // 2026-09-25 — the backoff it poisoned kept the initials forever).
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const startedAt = Date.now();
        const response = await fetch(url);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          this.noteActivity((counters) => {
            counters.fetches += 1;
            counters.fetchBytes += bytes.byteLength;
            counters.fetchWorstMs = Math.max(counters.fetchWorstMs, Date.now() - startedAt);
          });
          void this.writeDisk(image.key, bytes);
          return this.remember(image.key, bytes);
        }
        if (response.status === 404) {
          // 404 is NoSuchKey (an EXPIRED presigned link answers 400, not
          // 404) — but the row's URL could predate things, so verify against
          // a FRESH mint before declaring the object dead.
          if (attempt === 0) {
            const fresh = await this.mintFreshLink(image.key);
            if (fresh !== null) {
              url = fresh;
              continue;
            }
          }
          this.markDead(image.key, "404");
          return null;
        }
      } catch {
        // network error — fall through to the recovery mint
      }
      const fresh = await this.mintFreshLink(image.key);
      if (fresh === null) {
        this.markBackoff(image.key);
        return null;
      }
      url = fresh;
    }
    this.markBackoff(image.key);
    return null;
  }

  /** A fresh presigned link, or null when this cache has no rest client (the
   *  dormant one) or the mint itself failed. */
  private async mintFreshLink(key: string): Promise<string | null> {
    const client = this.rest();
    if (client === null) {
      return null;
    }
    return client.freshAttachmentLink(key).catch(() => null);
  }

  private markDead(key: string, reason: string): void {
    if (this.deadKeys.size > 1000) {
      this.deadKeys.clear(); // growth guard — a wiped cache only costs retries
    }
    this.deadKeys.add(key);
    this.backoffUntil.delete(key);
    log.warn("media", `attachment ${key} is gone (${reason}) — placeholder for the rest of the session`);
  }

  private markBackoff(key: string): void {
    this.backoffUntil.set(key, Date.now() + TRANSIENT_BACKOFF_MS);
    log.warn("media", `attachment ${key} unavailable (transient) — retry in ${TRANSIENT_BACKOFF_MS / 1000}s`);
  }

  private remember(key: string, bytes: Uint8Array): string {
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
    this.memory.set(key, objectUrl);
    this.deadKeys.delete(key); // a revived object rehabilitates fully
    this.backoffUntil.delete(key);
    while (this.memory.size > this.memoryCap) {
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
      this.scheduleTrim();
    } catch (error) {
      log.warn("cache", `disk write for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A trim walks the whole cache directory (an IPC round trip + one stat per
   *  file) — the idle prefetch used to fire one after EVERY downloaded image,
   *  hammering the main process. One per 30 s of write activity is plenty. */
  private scheduleTrim(): void {
    if (this.trimTimer !== null) {
      return;
    }
    this.trimTimer = setTimeout(() => {
      this.trimTimer = null;
      void this.trimDisk();
    }, 30_000);
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

let dormantInstance: AttachmentCache | null = null;

/**
 * The SESSION-LESS SHARED cache — one instance for every avatar that must NOT
 * depend on which record is active (the aggregated DM/friend rows, the rail's
 * saved server icons). Disk-first (the shared main-process cache), then a
 * direct fetch of the row's own presigned URL; `rest: () => null` means no
 * fresh-link mint — a miss falls back to the initials disc. Because the cache
 * OBJECT survives instance switches, its in-memory objectURLs do too — the
 * rows never flash fallbacks on promote (live report 2026-09-24). Also the
 * offline-startup path: server icons render from disk while no connection is
 * live. The default disk budget is deliberate: whatever it writes comes from
 * row URLs, and the live sessions' budget discipline (purge at 0) still owns
 * the disk as a whole.
 */
export function dormantAttachmentCache(): AttachmentCache {
  if (dormantInstance === null) {
    dormantInstance = new AttachmentCache(() => null, DORMANT_MEMORY_CAP);
  }
  return dormantInstance;
}
