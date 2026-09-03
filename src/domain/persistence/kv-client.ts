import { log } from "../../logging";

/**
 * Renderer-side KV client over the preload bridge. All mutations are declarative —
 * the read-modify-write happens under the main-process per-key lock, so a token
 * rotation can never clobber a concurrent UI write (lastChannel, prefs, volumes).
 */

interface KvBridge {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  merge(key: string, partial: Record<string, unknown>): Promise<unknown>;
  rotateTokens(key: string, expectedRefreshToken: string, tokens: { token: string; refreshToken: string; expiresAt: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  keys(prefix: string): Promise<unknown>;
}

declare global {
  interface Window {
    spaceKv?: KvBridge;
  }
}

function bridge(): KvBridge | null {
  if (typeof window !== "undefined" && window.spaceKv) {
    return window.spaceKv;
  }
  return null; // unit tests run in node without the bridge
}

/** In-memory fallback for tests/dev-without-preload; the KV file wins when present. */
const memoryFallback = new Map<string, unknown>();

/** Mirrors the main-process filename sanitizing — canonical in BOTH worlds. */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-z0-9-_.]/gi, "_");
}

export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const client = bridge();
    if (client) {
      try {
        return (await client.get(key)) as T | null;
      } catch (error) {
        log.warn("kv", `get ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    return (memoryFallback.get(sanitizeKey(key)) as T | null) ?? null;
  },

  async set(key: string, value: unknown): Promise<void> {
    const client = bridge();
    if (client) {
      await client.set(key, value);
      return;
    }
    memoryFallback.set(sanitizeKey(key), value);
  },

  async merge(key: string, partial: Record<string, unknown>): Promise<void> {
    const client = bridge();
    if (client) {
      await client.merge(key, partial);
      return;
    }
    const canonical = sanitizeKey(key);
    memoryFallback.set(canonical, { ...((memoryFallback.get(canonical) as object) ?? {}), ...partial });
  },

  /**
   * Returns the FINAL record as stored by main — when the CAS loses to a concurrent
   * rotation, that is the OTHER (newer) record, and the caller heals its memory copy.
   */
  async rotateTokens(key: string, expectedRefreshToken: string, tokens: { token: string; refreshToken: string; expiresAt: number }): Promise<unknown> {
    const client = bridge();
    if (client) {
      return await client.rotateTokens(key, expectedRefreshToken, tokens);
    }
    const canonical = sanitizeKey(key);
    const merged = { ...((memoryFallback.get(canonical) as object) ?? {}), ...tokens };
    memoryFallback.set(canonical, merged);
    return merged;
  },

  async delete(key: string): Promise<void> {
    const client = bridge();
    if (client) {
      await client.delete(key);
      return;
    }
    memoryFallback.delete(sanitizeKey(key));
  },

  /** Returns SANITIZED key names starting with the (sanitized) prefix. */
  async keys(prefix: string): Promise<string[]> {
    const client = bridge();
    if (client) {
      try {
        return (await client.keys(prefix)) as string[];
      } catch (error) {
        log.warn("kv", `keys ${prefix} failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }
    return [...memoryFallback.keys()].filter((key) => key.startsWith(sanitizeKey(prefix)));
  },
};
