import { describe, expect, it } from "vitest";
import { RestClient } from "../src/core/rest";
import { MemoryTokenStorage } from "../src/core/auth";
import { FakeFetch } from "./mocks/fake-fetch";
import type { Message } from "../src/types";

/**
 * Wire contracts for the search endpoint and the aroundId/afterId history cursors
 * (#481) — paths and query orders are the server's ground truth (oak-server
 * SearchController / MessageController).
 */
function message(id: number): Message {
  return {
    id,
    channelId: 5,
    authorId: 10,
    authorUsername: "alice",
    content: "hit",
    createdAt: "2026-09-18T10:15:30.123Z",
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
  };
}

describe("RestClient search + history cursors (#481)", () => {
  it("getMessages appends the aroundId / afterId cursor params after the classic ones", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: [] }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    await client.getMessages(5, undefined, 50, { aroundId: 7 });
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages?limit=50&aroundId=7");

    await client.getMessages(5, undefined, 50, { afterId: 42 });
    expect(fake.requests[1]?.path).toBe("/api/channels/5/messages?limit=50&afterId=42");

    await client.getMessages(5, 12, 50);
    expect(fake.requests[2]?.path).toBe("/api/channels/5/messages?limit=50&beforeId=12");
  });

  it("searchMessages builds the filter set and maps the response", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { total: 7, results: [message(9)] } }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    const result = await client.searchMessages({
      q: "needle",
      channelId: 5,
      author: "bob",
      beforeId: 100,
      limit: 25,
    });

    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path)
      .toBe("/api/search/messages?q=needle&channelId=5&author=bob&beforeId=100&limit=25");
    expect(result.total).toBe(7);
    expect(result.results.map((entry) => entry.id)).toEqual([9]);
  });

  it("searchMessages omits the empty optional filters (server-wide, author-only)", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { total: 0, results: [] } }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    await client.searchMessages({ q: null, channelId: null, author: "bob" });
    expect(fake.requests[0]?.path).toBe("/api/search/messages?author=bob");

    await client.searchMessages({ q: "needle" });
    expect(fake.requests[1]?.path).toBe("/api/search/messages?q=needle");
  });
});
