import type { AuthTokens } from "../types";

/**
 * Token persistence. The storage interface is the seam — production binds localStorage,
 * tests bind an in-memory map. Spike posture: localStorage of a sandboxed local page is
 * acceptable; moving the refresh token behind safeStorage is a documented later option.
 */
export interface TokenStorage {
  load(): AuthTokens | null;
  save(tokens: AuthTokens): void;
  clear(): void;
}

const STORAGE_KEY = "space.tokens";

export class LocalTokenStorage implements TokenStorage {
  load(): AuthTokens | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as AuthTokens;
      if (typeof parsed.token === "string" && typeof parsed.refreshToken === "string" && typeof parsed.expiresAt === "number") {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  save(tokens: AuthTokens): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  }

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** In-memory storage for tests and pre-login plumbing. */
export class MemoryTokenStorage implements TokenStorage {
  private tokens: AuthTokens | null = null;

  load(): AuthTokens | null {
    return this.tokens;
  }

  save(tokens: AuthTokens): void {
    this.tokens = { ...tokens };
  }

  clear(): void {
    this.tokens = null;
  }
}
