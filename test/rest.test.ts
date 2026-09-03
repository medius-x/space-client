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
});
