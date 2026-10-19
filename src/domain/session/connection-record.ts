import { Emitter } from "../lib/store";
import { kv } from "../persistence/kv-client";
import { sanitizeRailOrder, sortRecordsForRail } from "../logic/rail-drag";
import type { TokenStorage } from "../../core/auth";
import type { AuthTokens, NotificationPrefs } from "../../types";
import { log } from "../../logging";

/**
 * Port of oak-client's ServerConnection: everything the app remembers about one
 * server login — tokens, the last opened channel, per-user volumes. One KV FILE per
 * record (`connection:{id}`), which is what makes kv.merge and the CAS rotation apply
 * to a single record without touching its siblings.
 */

export interface ConnectionRecord {
  /** uuid — sanitize-stable, so it survives the KV filename unmangled. */
  id: string;
  /** Normalized origin (no trailing slash), e.g. http://localhost:8080 or
   *  https://203.0.113.10 (the TLS entry point). */
  hostUrl: string;
  username: string;
  token: string;
  refreshToken: string;
  /** Epoch ms when the access token dies. */
  expiresAt: number;
  createdAt: number;
  lastUsedAt: number;
  lastChannelId: number | null;
  cachedServerName: string | null;
  /** Stable MinIO key of the server icon (offline rail rendering by key). */
  cachedServerAvatarKey: string | null;
  /** Stable MinIO key of the logged-in user's own avatar — the offline view's
   *  user panel renders by key from the disk cache (the roster is empty there,
   *  so this record field is the only offline source of the key). */
  cachedOwnAvatarKey?: string | null;
  /** The self-signed server certificate's SHA-256 pin (normalized hex, no
   *  separators), written by MAIN when the user trusts the certificate — the
   *  key-by-HOSTNAME TOFU pin of the TLS entry point. Null on http servers and
   *  CA-signed https (nothing to pin). */
  certFingerprint?: string | null;
  /** username → gain multiplier (1.0 = 100%). */
  voiceVolumes: Record<string, number>;
  shareVolumes: Record<string, number>;
  /** Per-server notification overrides; the default is MENTIONS (user decision,
   *  audit round 7 — oak ships ALL, which spams background-instance toasts). */
  notifPrefs: NotificationPrefs;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { mode: "MENTIONS", suppressEveryoneHere: false };

export interface NewConnection {
  hostUrl: string;
  username: string;
  tokens: AuthTokens;
}

const KEY_PREFIX = "connection:";
/** The sanitized form of KEY_PREFIX — what kv.keys() returns on the wire. */
const SANITIZED_KEY_PREFIX = "connection_";
/** The manually set rail order (a plain array of record ids). Deliberately NOT
 *  `connection:…` — the M7 encryption gate only covers record files (tokens);
 *  ids carry no secrets, and the hyphen keeps it out of kv.keys("connection_"). */
const ORDER_KEY = "connection-order";

export function recordKey(recordId: string): string {
  return `${KEY_PREFIX}${recordId}`;
}

function newRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for exotic contexts; uuid-shaped but not cryptographic.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const randomValue = Math.floor(Math.random() * 16);
    const digit = char === "x" ? randomValue : (randomValue & 0x3) | 0x8;
    return digit.toString(16);
  });
}

/**
 * Normalizes a typed server address into an origin: trims, drops trailing
 * slashes, and PREFIXES a scheme when the user typed a bare host — localhost
 * defaults to http (the dev topology), everything else to https (a deployed
 * server is the TLS entry point since round B; type "http://host:8080"
 * explicitly for a plain deployment).
 */
export function normalizeHostUrl(hostUrl: string): string {
  const trimmed = hostUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(trimmed);
    return `${isLocal ? "http" : "https"}://${trimmed}`;
  }
  return trimmed;
}

/** A normalized address the app can actually speak (only http/https origins). */
export function isValidHostUrl(normalizedHostUrl: string): boolean {
  return /^https?:\/\/[^\s/]+$/i.test(normalizedHostUrl);
}

function isValidRecord(value: unknown): value is ConnectionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ConnectionRecord>;
  return typeof candidate.id === "string"
    && typeof candidate.hostUrl === "string"
    && typeof candidate.username === "string"
    && typeof candidate.token === "string"
    && typeof candidate.refreshToken === "string";
}

/** A record with its tokens wiped — the rail shows it as "needs re-login". */
export const EXPIRED_MARKER = "expired";

/**
 * Reactive directory of saved connections (the rail's store). All durable writes go
 * through main's per-key lock; the in-memory map is updated FIRST so synchronous
 * load() calls inside one renderer always see fresh tokens.
 */
export class ConnectionDirectory extends Emitter {
  private readonly records = new Map<string, ConnectionRecord>();
  private snapshot: readonly ConnectionRecord[] = [];
  /** The manually dragged rail order (persisted as ORDER_KEY); records missing
   *  from it fall back to join order — see sortRecordsForRail. */
  private railOrder: string[] = [];
  private loaded = false;

  getSnapshot = (): readonly ConnectionRecord[] => this.snapshot;

  isLoaded(): boolean {
    return this.loaded;
  }

  get(recordId: string): ConnectionRecord | null {
    return this.records.get(recordId) ?? null;
  }

  /**
   * The rail order: the persisted manual order first, then records never
   * manually positioned, by join order (createdAt asc). Deterministic by
   * construction — lastUsedAt plays no part (it used to, and parallel session
   * starts at boot reshuffled the rail in completion order; user report
   * 2026-10-19).
   */
  async loadAll(): Promise<readonly ConnectionRecord[]> {
    const sanitizedKeys = await kv.keys(SANITIZED_KEY_PREFIX);
    for (const sanitizedKey of sanitizedKeys) {
      const record = await kv.get<ConnectionRecord>(sanitizedKey);
      if (isValidRecord(record)) {
        // Pre-M7 records carry no prefs / no avatar key — default them in memory
        // (the merge below only happens on the next explicit write).
        this.records.set(record.id, {
          ...record,
          notifPrefs: record.notifPrefs ?? DEFAULT_NOTIFICATION_PREFS,
          cachedServerAvatarKey: record.cachedServerAvatarKey ?? null,
        });
      }
    }
    this.railOrder = sanitizeRailOrder(await kv.get<unknown>(ORDER_KEY));
    this.loaded = true;
    this.rebuildSnapshot();
    return this.snapshot;
  }

  /**
   * The manual reorder's persist: memory first (the rail repaints instantly),
   * the durable write fire-and-forget like SettingsStore.apply — a local KV
   * file, no server round-trip to roll back from. The input must list every
   * record exactly once; anything else throws BEFORE any mutation.
   */
  async reorder(nextIds: readonly string[]): Promise<void> {
    const nextSet = new Set(nextIds);
    if (nextSet.size !== nextIds.length || nextSet.size !== this.records.size) {
      throw new Error("rail order must list every record exactly once");
    }
    for (const recordId of nextSet) {
      if (!this.records.has(recordId)) {
        throw new Error("rail order must list every record exactly once");
      }
    }
    this.railOrder = [...nextIds];
    this.rebuildSnapshot();
    this.emit();
    void kv.set(ORDER_KEY, this.railOrder);
  }

  /**
   * The boot auto-resume / delete-survivor pick — the ONE legitimate consumer of
   * "recency" (the rail itself no longer sorts by it). Ties broken by id so the
   * choice is deterministic.
   */
  mostRecentlyUsed(): ConnectionRecord | null {
    let newest: ConnectionRecord | null = null;
    for (const record of this.records.values()) {
      if (newest === null
        || record.lastUsedAt > newest.lastUsedAt
        || (record.lastUsedAt === newest.lastUsedAt && record.id > newest.id)) {
        newest = record;
      }
    }
    return newest;
  }

  async create(input: NewConnection): Promise<ConnectionRecord> {
    const now = Date.now();
    const record: ConnectionRecord = {
      id: newRecordId(),
      hostUrl: normalizeHostUrl(input.hostUrl),
      username: input.username,
      token: input.tokens.token,
      refreshToken: input.tokens.refreshToken,
      expiresAt: input.tokens.expiresAt,
      createdAt: now,
      lastUsedAt: now,
      lastChannelId: null,
      cachedServerName: null,
      cachedServerAvatarKey: null,
      voiceVolumes: {},
      shareVolumes: {},
      notifPrefs: DEFAULT_NOTIFICATION_PREFS,
    };
    this.records.set(record.id, record);
    this.rebuildSnapshot();
    await kv.set(recordKey(record.id), record);
    this.emit();
    return record;
  }

  /** Partial update under the main-process lock; the memory copy changes first. */
  async update(recordId: string, partial: Partial<Omit<ConnectionRecord, "id">>): Promise<void> {
    const record = this.records.get(recordId);
    if (!record) {
      return;
    }
    this.records.set(recordId, { ...record, ...partial });
    this.rebuildSnapshot();
    this.emit();
    await kv.merge(recordKey(recordId), partial as Record<string, unknown>);
  }

  async touch(recordId: string): Promise<void> {
    await this.update(recordId, { lastUsedAt: Date.now() });
  }

  async remove(recordId: string): Promise<void> {
    if (!this.records.delete(recordId)) {
      return;
    }
    this.rebuildSnapshot();
    this.emit();
    await kv.delete(recordKey(recordId));
  }

  /**
   * Token writes from a live RestClient. Sync memory first, then the durable write —
   * a rotation goes through CAS: if another session already rotated the family, main
   * keeps the NEWER record and we adopt it here (the returned final value).
   */
  applyTokens(recordId: string, tokens: AuthTokens, previous: AuthTokens | null): void | Promise<void> {
    const record = this.records.get(recordId);
    if (!record) {
      return;
    }
    this.records.set(recordId, { ...record, ...tokens });
    this.rebuildSnapshot();
    this.emit();
    const key = recordKey(recordId);
    if (previous !== null && previous.refreshToken === record.refreshToken) {
      // The disk (as we know it) still holds the PREVIOUS family → CAS applies ours,
      // and a lost race returns the newer record for us to adopt.
      return kv.rotateTokens(key, previous.refreshToken, tokens).then((finalValue) => {
        if (isValidRecord(finalValue)) {
          this.records.set(recordId, finalValue);
          this.rebuildSnapshot();
          this.emit();
        }
      });
    }
    return kv.merge(key, { ...tokens });
  }

  async markExpired(recordId: string): Promise<void> {
    const record = this.records.get(recordId);
    if (!record) {
      return;
    }
    this.records.set(recordId, { ...record, token: EXPIRED_MARKER, refreshToken: "" });
    this.rebuildSnapshot();
    this.emit();
    await kv.set(recordKey(recordId), this.records.get(recordId));
  }

  private readonly volumeFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Volume-slider writes: memory NOW (the next attach reads it), durable KV coalesced
   * behind a trailing timer — a slider drag fires dozens of writes per second and the
   * disk does not need any of them until the drag settles.
   */
  setVolume(recordId: string, kind: "voice" | "share", username: string, gain: number): void {
    const record = this.records.get(recordId);
    if (!record) {
      return;
    }
    const updated: ConnectionRecord = kind === "voice"
      ? { ...record, voiceVolumes: { ...record.voiceVolumes, [username]: gain } }
      : { ...record, shareVolumes: { ...record.shareVolumes, [username]: gain } };
    this.records.set(recordId, updated);
    this.rebuildSnapshot();
    this.emit();

    const timerKey = `${recordId}:${kind}`;
    const pending = this.volumeFlushTimers.get(timerKey);
    if (pending) {
      clearTimeout(pending);
    }
    this.volumeFlushTimers.set(timerKey, setTimeout(() => {
      this.volumeFlushTimers.delete(timerKey);
      const current = this.records.get(recordId);
      if (current) {
        void kv.merge(recordKey(recordId), { voiceVolumes: current.voiceVolumes, shareVolumes: current.shareVolumes });
      }
    }, 800));
  }

  private rebuildSnapshot(): void {
    this.snapshot = sortRecordsForRail([...this.records.values()], this.railOrder);
  }
}

/**
 * Bridges the RestClient's TokenStorage contract onto a directory record. load() is
 * synchronous by design — the in-memory copy is always at least as fresh as the disk.
 */
export class RecordTokenStorage implements TokenStorage {
  constructor(
    private readonly directory: ConnectionDirectory,
    private readonly recordId: string,
  ) {}

  load(): AuthTokens | null {
    const record = this.directory.get(this.recordId);
    if (!record || record.token === EXPIRED_MARKER || record.refreshToken === "") {
      return null;
    }
    return { token: record.token, refreshToken: record.refreshToken, expiresAt: record.expiresAt };
  }

  save(tokens: AuthTokens, previous?: AuthTokens | null): void | Promise<void> {
    return this.directory.applyTokens(this.recordId, tokens, previous ?? null);
  }

  clear(): void {
    // Wiping tokens outright would lose the rail entry; the session layer decides
    // between markExpired (keep, re-login) and remove (user asked to forget).
    void this.directory.markExpired(this.recordId);
  }
}
