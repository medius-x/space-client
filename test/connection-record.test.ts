import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionDirectory,
  EXPIRED_MARKER,
  isValidHostUrl,
  normalizeHostUrl,
  RecordTokenStorage,
  recordKey,
} from "../src/domain/session/connection-record";
import type { ConnectionRecord } from "../src/domain/session/connection-record";
import type { AuthTokens } from "../src/types";

/**
 * The directory runs against the kv memory fallback (node has no preload bridge);
 * a FAKE bridge on globalThis.window verifies the IPC routing — CAS rotation vs
 * plain merge — without Electron.
 */

interface BridgeCalls {
  merge: string[];
  rotate: Array<{ key: string; expectedRefreshToken: string }>;
  deleted: string[];
  stored: Map<string, unknown>;
}

function installFakeBridge(): BridgeCalls {
  const calls: BridgeCalls = { merge: [], rotate: [], deleted: [], stored: new Map() };
  const bridge = {
    get: async (key: string) => (calls.stored.has(key) ? calls.stored.get(key) : null),
    set: async (key: string, value: unknown) => {
      calls.stored.set(key, value);
      return value;
    },
    merge: async (key: string, partial: Record<string, unknown>) => {
      calls.merge.push(key);
      const current = (calls.stored.get(key) as object | undefined) ?? {};
      const next = { ...current, ...partial };
      calls.stored.set(key, next);
      return next;
    },
    rotateTokens: async (key: string, expectedRefreshToken: string, tokens: AuthTokens) => {
      calls.rotate.push({ key, expectedRefreshToken });
      const record = (calls.stored.get(key) as Partial<ConnectionRecord> | undefined) ?? {};
      if (typeof record.refreshToken === "string" && record.refreshToken !== expectedRefreshToken) {
        return record; // the race loser gets the NEWER disk record back
      }
      const next = { ...record, ...tokens };
      calls.stored.set(key, next);
      return next;
    },
    delete: async (key: string) => {
      calls.deleted.push(key);
      calls.stored.delete(key);
      return null;
    },
    keys: async () => [...calls.stored.keys()],
  };
  (globalThis as { window?: unknown }).window = { spaceKv: bridge };
  return calls;
}

function clearWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

function tokens(suffix: string): AuthTokens {
  return { token: `access-${suffix}`, refreshToken: `refresh-${suffix}`, expiresAt: 1_000 };
}

afterEach(() => {
  clearWindow();
  vi.restoreAllMocks();
});

describe("ConnectionDirectory", () => {
  it("creates a record, lists it, updates fields under merge, and removes it", async () => {
    const directory = new ConnectionDirectory();
    const record = await directory.create({ hostUrl: "http://x:8080/", username: "alice", tokens: tokens("1") });

    expect(record.hostUrl).toBe("http://x:8080"); // normalized
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(directory.getSnapshot()).toHaveLength(1);

    await directory.update(record.id, { lastChannelId: 7, cachedServerName: "Oak" });
    const updated = directory.get(record.id);
    expect(updated?.lastChannelId).toBe(7);
    expect(updated?.cachedServerName).toBe("Oak");
    expect(updated?.username).toBe("alice"); // untouched fields survive

    await directory.remove(record.id);
    expect(directory.getSnapshot()).toHaveLength(0);
    expect(directory.get(record.id)).toBeNull();
  });

  it("loadAll restores what disk holds", async () => {
    const first = new ConnectionDirectory();
    const older = await first.create({ hostUrl: "http://a", username: "a", tokens: tokens("a") });
    const newer = await first.create({ hostUrl: "http://b", username: "b", tokens: tokens("b") });
    await first.update(newer.id, { lastUsedAt: Date.now() + 5_000 });
    await first.remove(older.id); // keep exactly one record on "disk"

    const second = new ConnectionDirectory();
    const restored = await second.loadAll();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(newer.id);
    expect(second.getSnapshot()[0]?.username).toBe("b");
  });

  it("the rail order is join order — touch() (a session start) no longer reshuffles it", async () => {
    const directory = new ConnectionDirectory();
    const first = await directory.create({ hostUrl: "http://a", username: "a", tokens: tokens("a") });
    const second = await directory.create({ hostUrl: "http://b", username: "b", tokens: tokens("b") });
    // Pin createdAt: two creates can land in the same millisecond.
    await directory.update(first.id, { createdAt: 1_000, lastUsedAt: 9_000 });
    await directory.update(second.id, { createdAt: 2_000, lastUsedAt: 1_000 });

    expect(directory.getSnapshot().map((record) => record.id)).toEqual([first.id, second.id]);

    await directory.touch(second.id); // recency bumps — the boot shuffle's root cause
    expect(directory.getSnapshot().map((record) => record.id)).toEqual([first.id, second.id]); // rail intact
    expect(directory.mostRecentlyUsed()?.id).toBe(second.id); // recency lives HERE now
  });

  it("reorder() sets the manual order, persists it, and loadAll restores it", async () => {
    const calls = installFakeBridge();
    const directory = new ConnectionDirectory();
    const first = await directory.create({ hostUrl: "http://a", username: "a", tokens: tokens("a") });
    const second = await directory.create({ hostUrl: "http://b", username: "b", tokens: tokens("b") });
    await directory.update(first.id, { createdAt: 1_000 });
    await directory.update(second.id, { createdAt: 2_000 });
    expect(directory.getSnapshot().map((record) => record.id)).toEqual([first.id, second.id]);

    await directory.reorder([second.id, first.id]);
    expect(directory.getSnapshot().map((record) => record.id)).toEqual([second.id, first.id]);
    expect(calls.stored.get("connection-order")).toEqual([second.id, first.id]);

    const reopened = new ConnectionDirectory();
    await reopened.loadAll();
    expect(reopened.getSnapshot().map((record) => record.id)).toEqual([second.id, first.id]);
  });

  it("reorder() rejects an input that is not exactly the current record set", async () => {
    const directory = new ConnectionDirectory();
    const first = await directory.create({ hostUrl: "http://a", username: "a", tokens: tokens("a") });
    const second = await directory.create({ hostUrl: "http://b", username: "b", tokens: tokens("b") });
    await directory.update(first.id, { createdAt: 1_000 });
    await directory.update(second.id, { createdAt: 2_000 });

    await expect(directory.reorder([first.id])).rejects.toThrow(); // missing a record
    await expect(directory.reorder([first.id, second.id, "ghost"])).rejects.toThrow(); // unknown id
    await expect(directory.reorder([first.id, first.id])).rejects.toThrow(); // duplicate
    expect(directory.getSnapshot().map((record) => record.id)).toEqual([first.id, second.id]); // untouched
  });

  it("mostRecentlyUsed() picks the max lastUsedAt, ties broken by id", async () => {
    const directory = new ConnectionDirectory();
    expect(directory.mostRecentlyUsed()).toBeNull();

    const first = await directory.create({ hostUrl: "http://a", username: "a", tokens: tokens("a") });
    const second = await directory.create({ hostUrl: "http://b", username: "b", tokens: tokens("b") });
    await directory.update(first.id, { lastUsedAt: 5_000 });
    await directory.update(second.id, { lastUsedAt: 5_000 });
    expect(directory.mostRecentlyUsed()?.id).toBe(first.id > second.id ? first.id : second.id);

    await directory.update(first.id, { lastUsedAt: 6_000 });
    expect(directory.mostRecentlyUsed()?.id).toBe(first.id);
  });

  it("markExpired wipes tokens but keeps the rail entry", async () => {
    const directory = new ConnectionDirectory();
    const record = await directory.create({ hostUrl: "http://x", username: "alice", tokens: tokens("1") });
    await directory.markExpired(record.id);

    const storage = new RecordTokenStorage(directory, record.id);
    expect(storage.load()).toBeNull(); // expired → no tokens for the REST client
    expect(directory.get(record.id)?.username).toBe("alice");
  });

  it("setVolume updates memory immediately and coalesces the durable write", async () => {
    vi.useFakeTimers();
    const calls = installFakeBridge();
    const directory = new ConnectionDirectory();
    const record = await directory.create({ hostUrl: "http://x", username: "alice", tokens: tokens("1") });
    const storage = new RecordTokenStorage(directory, record.id);

    // create() wrote once; a session then logs in again (merge) — reset the log.
    calls.merge.length = 0;

    directory.setVolume(record.id, "voice", "bob", 1.5);
    directory.setVolume(record.id, "voice", "bob", 0.25); // drag continues
    expect(directory.get(record.id)?.voiceVolumes.bob).toBe(0.25); // memory is fresh NOW

    expect(calls.merge).toHaveLength(0); // nothing durable yet
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.merge).toHaveLength(1); // exactly one coalesced flush

    const persisted = calls.stored.get(recordKey(record.id)) as ConnectionRecord;
    expect(persisted.voiceVolumes.bob).toBe(0.25);

    storage.load(); // keep storage referenced
    vi.useRealTimers();
  });
});

describe("RecordTokenStorage IPC routing", () => {
  it("routes a rotation through CAS (rotateTokens) and a first write through merge", async () => {
    const calls = installFakeBridge();
    const directory = new ConnectionDirectory();
    const record = await directory.create({ hostUrl: "http://x", username: "alice", tokens: tokens("1") });
    const storage = new RecordTokenStorage(directory, record.id);

    calls.merge.length = 0;

    // Refresh path: previous family known → CAS.
    await storage.save(tokens("2"), tokens("1"));
    expect(calls.rotate).toHaveLength(1);
    expect(calls.rotate[0]?.key).toBe(recordKey(record.id));
    expect(calls.rotate[0]?.expectedRefreshToken).toBe("refresh-1");
    expect(storage.load()?.token).toBe("access-2"); // memory saw it immediately

    // Login-after-expiry path: no previous family → plain merge.
    await directory.markExpired(record.id);
    calls.merge.length = 0;
    await storage.save(tokens("3"), null);
    expect(calls.merge).toHaveLength(1);
    expect(calls.rotate).toHaveLength(1); // unchanged
  });

  it("adopts the newer disk record when the rotation loses the CAS race", async () => {
    const calls = installFakeBridge();
    const directory = new ConnectionDirectory();
    const record = await directory.create({ hostUrl: "http://x", username: "alice", tokens: tokens("1") });
    const storage = new RecordTokenStorage(directory, record.id);

    // Another window already rotated the family on disk.
    const diskRecord = (await calls.stored.get(recordKey(record.id))) as ConnectionRecord;
    calls.stored.set(recordKey(record.id), { ...diskRecord, token: "access-winner", refreshToken: "refresh-winner" });

    await storage.save(tokens("loser"), tokens("1"));
    expect(storage.load()?.token).toBe("access-winner"); // healed to the disk truth
  });
});

describe("normalizeHostUrl", () => {
  it("keeps explicit schemes and trims trailing slashes", () => {
    expect(normalizeHostUrl(" https://203.0.113.10/ ")).toBe("https://203.0.113.10");
    expect(normalizeHostUrl("http://localhost:8080///")).toBe("http://localhost:8080");
  });

  it("auto-prefixes a scheme: localhost stays http, a deployed host becomes https", () => {
    expect(normalizeHostUrl("localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeHostUrl("127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeHostUrl("[::1]:8443")).toBe("http://[::1]:8443");
    expect(normalizeHostUrl("203.0.113.10")).toBe("https://203.0.113.10");
    expect(normalizeHostUrl("oak.example.com")).toBe("https://oak.example.com");
  });

  it("leaves non-http schemes for isValidHostUrl to reject", () => {
    expect(normalizeHostUrl("ftp://x")).toBe("ftp://x");
  });
});

describe("isValidHostUrl", () => {
  it("accepts only http/https origins", () => {
    expect(isValidHostUrl("http://localhost:8080")).toBe(true);
    expect(isValidHostUrl("https://203.0.113.10")).toBe(true);
    expect(isValidHostUrl("https://oak.example.com:8443")).toBe(true);
    expect(isValidHostUrl("ftp://x")).toBe(false);
    expect(isValidHostUrl("")).toBe(false);
    expect(isValidHostUrl("https://host/some/path")).toBe(false); // origins only
  });
});
