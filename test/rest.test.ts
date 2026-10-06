import { describe, expect, it } from "vitest";
import { ApiError, RestClient } from "../src/core/rest";
import { MemoryTokenStorage } from "../src/core/auth";
import { FakeFetch, type RecordedRequest } from "./mocks/fake-fetch";

function authBody(requestIndex: number): { token: string; refreshToken: string; tokenType: string; expiresIn: number } {
  return { token: `access-${requestIndex}`, refreshToken: `refresh-${requestIndex}`, tokenType: "Bearer", expiresIn: 28_800 };
}

describe("RestClient", () => {
  it("logs in and carries the Bearer token on subsequent calls", async () => {
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/auth/login") {
        return { status: 200, body: authBody(1) };
      }
      return { status: 200, body: [] };
    });
    const storage = new MemoryTokenStorage();
    const client = new RestClient({ baseUrl: "http://localhost:8080/", tokenStorage: storage, fetchImpl: fake.call });

    await client.login("alice", "password123");
    await client.getChannels();

    expect(fake.requests[0]?.path).toBe("/api/auth/login");
    expect(fake.requests[1]?.authorization).toBe("Bearer access-1");
  });

  it("reports per-attempt request latency for the connection-quality indicator", async () => {
    const latencies: { path: string; millis: number }[] = [];
    const fake = new FakeFetch(() => ({ status: 200, body: [] }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
      onRequestLatency: (info) => latencies.push(info),
    });

    await client.getChannels();

    expect(latencies).toHaveLength(1);
    expect(latencies[0]?.path).toBe("/api/channels");
    expect(latencies[0]?.millis).toBeGreaterThanOrEqual(0);
  });

  it("a request with NO answer reports no latency sample (no round trip happened)", async () => {
    const latencies: { path: string; millis: number }[] = [];
    const fake = new FakeFetch(() => {
      throw new Error("network down");
    });
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
      retryDelaysMs: [0],
      onRequestLatency: (info) => latencies.push(info),
    });

    await expect(client.getChannels()).rejects.toThrow("network down");
    expect(latencies).toHaveLength(0);
  });

  it("silently refreshes ONCE for N parallel 401s (single-flight)", async () => {
    const storage = new MemoryTokenStorage();
    storage.save({ token: "expired", refreshToken: "refresh-old", expiresAt: 0 });
    let refreshCalls = 0;
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/auth/refresh") {
        refreshCalls += 1;
        return { status: 200, body: authBody(refreshCalls) };
      }
      // channels 401 unless the fresh token is used
      if (request.authorization === "Bearer expired") {
        return { status: 401, body: { message: "Expired" } };
      }
      return { status: 200, body: [{ id: 1, name: "general", type: "TEXT" }] };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call });

    const [first, second, third] = await Promise.all([client.getChannels(), client.getChannels(), client.getChannels()]);

    expect(refreshCalls).toBe(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(storage.load()?.token).toBe("access-1");
  });

  it("clears the session and fires onSessionExpired when the refresh family dies", async () => {
    const storage = new MemoryTokenStorage();
    storage.save({ token: "expired", refreshToken: "dead", expiresAt: 0 });
    let expiredFired = false;
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/auth/refresh") {
        return { status: 401, body: { message: "Unknown token" } };
      }
      return { status: 401, body: { message: "Expired" } };
    });
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: storage,
      fetchImpl: fake.call,
      onSessionExpired: () => {
        expiredFired = true;
      },
    });

    await expect(client.getChannels()).rejects.toThrow(ApiError);
    expect(expiredFired).toBe(true);
    expect(storage.load()).toBeNull();
  });

  it("retries a 401 exactly once — a second 401 surfaces as an error", async () => {
    const storage = new MemoryTokenStorage();
    storage.save({ token: "bad", refreshToken: "also-bad", expiresAt: 0 });
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/auth/refresh") {
        return { status: 200, body: authBody(1) };
      }
      return { status: 403, body: { message: "Forbidden" } };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call });

    await expect(client.getRoom(7)).rejects.toThrow("Forbidden");
  });

  it("surfaces the server's {message} body on errors", async () => {
    const fake = new FakeFetch(() => ({ status: 503, body: { message: "Janus gateway unavailable" } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await expect(client.getRoom(7)).rejects.toThrow("Janus gateway unavailable");
  });

  it("register logs in automatically after a 201", async () => {
    const fake = new FakeFetch((request: RecordedRequest) => {
      if (request.path === "/api/auth/register") {
        return { status: 201, body: { id: 5, username: "newbie" } };
      }
      if (request.path === "/api/auth/login") {
        return { status: 200, body: authBody(1) };
      }
      return { status: 200, body: [] };
    });
    const storage = new MemoryTokenStorage();
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call });

    await client.register("newbie", "password123");

    expect(storage.load()?.token).toBe("access-1");
    expect(fake.requests.map((request) => request.path)).toEqual(["/api/auth/register", "/api/auth/login"]);
  });

  it("logout POSTs the refresh token in the body, with no Bearer needed (M7)", async () => {
    const fake = new FakeFetch(() => ({ status: 204, body: null }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.logout("refresh-to-kill");

    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/auth/logout");
    expect(fake.requests[0]?.body).toEqual({ refreshToken: "refresh-to-kill" });
    // The credential rides the body — the call works on a session already torn down.
    expect(fake.requests[0]?.authorization).toBeNull();
  });

  it("logoutAll POSTs authenticated (the endpoint revokes by principal, M7)", async () => {
    const fake = new FakeFetch(() => ({ status: 204, body: null }));
    const storage = new MemoryTokenStorage();
    storage.save({ token: "live-access", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call });

    await client.logoutAll();

    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/auth/logout-all");
    expect(fake.requests[0]?.authorization).toBe("Bearer live-access");
  });

  // -------------------------------------------------------------------------
  // Network-resilience ladder: idempotent calls retry on NO-response failures;
  // server answers and plain POSTs never repeat.
  // -------------------------------------------------------------------------

  it("retries a GET through network failures (idempotent), then surfaces the last error", async () => {
    const fake = new FakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const storage = new MemoryTokenStorage();
    storage.save({ token: "t", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call, retryDelaysMs: [0, 0] });

    await expect(client.getChannels()).rejects.toThrow("Failed to fetch");
    expect(fake.requests).toHaveLength(3); // 1 + 2 retries
  });

  it("a GET that connects on the SECOND attempt resolves normally", async () => {
    let attempts = 0;
    const fake = new FakeFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("Failed to fetch");
      }
      return { status: 200, body: [{ id: 1, name: "general", type: "TEXT", position: 0 }] };
    });
    const storage = new MemoryTokenStorage();
    storage.save({ token: "t", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call, retryDelaysMs: [0, 0] });

    const channels = await client.getChannels();
    expect(channels).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("a plain POST is NOT retried — a lost response may already have acted", async () => {
    const fake = new FakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const storage = new MemoryTokenStorage();
    storage.save({ token: "t", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call, retryDelaysMs: [0, 0] });

    await expect(client.addFriend("bob")).rejects.toThrow("Failed to fetch");
    expect(fake.requests).toHaveLength(1); // one flight only — no duplicate friend request
  });

  it("a POST carrying an idempotency key IS retried (the server dedups by key)", async () => {
    let attempts = 0;
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/channels/1/messages") {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("Failed to fetch");
        }
        return { status: 201, body: { id: 42, channelId: 1, authorId: 1, authorUsername: "alice", content: "hi", createdAt: "now", attachments: [], mentions: [], reactions: [], editedAt: null, reply: null, forward: null, pinned: false, pinnedBy: null, pinnedAt: null, sticker: null } };
      }
      return { status: 200, body: [] };
    });
    const storage = new MemoryTokenStorage();
    storage.save({ token: "t", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call, retryDelaysMs: [0, 0] });

    const created = await client.sendMessage(1, { content: "hi", idempotencyKey: "key-1" });
    expect(created.id).toBe(42);
    expect(attempts).toBe(2); // the retry flew with the SAME key (same request body)
    expect(fake.requests[0]?.body).toMatchObject({ idempotencyKey: "key-1" });
    expect(fake.requests[1]?.body).toMatchObject({ idempotencyKey: "key-1" });
  });

  it("a server 5xx answer is NOT retried — the server spoke, repeating may re-trigger side effects", async () => {
    const fake = new FakeFetch(() => ({ status: 500, body: { message: "boom" } }));
    const storage = new MemoryTokenStorage();
    storage.save({ token: "t", refreshToken: "r", expiresAt: 0 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: storage, fetchImpl: fake.call, retryDelaysMs: [0, 0] });

    await expect(client.getChannels()).rejects.toThrow("boom");
    expect(fake.requests).toHaveLength(1);
  });
});
