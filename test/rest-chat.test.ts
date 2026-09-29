import { describe, expect, it } from "vitest";
import { RestClient } from "../src/core/rest";
import { MemoryTokenStorage } from "../src/core/auth";
import { FakeFetch } from "./mocks/fake-fetch";
import type { Message } from "../src/types";

/**
 * Wire contracts for the M1 chat/channel/profile endpoints — paths, methods and
 * bodies are the server's ground truth (verified against oak-server controllers).
 */
function message(id: number): Message {
  return {
    id,
    channelId: 5,
    authorId: 10,
    authorUsername: "alice",
    content: "hello",
    createdAt: "2026-09-04T10:15:30.123Z",
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
    sticker: null,
  };
}

describe("RestClient chat + channels + profile (M1)", () => {
  it("getMessages builds the pagination query and returns the oldest-first page", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: [message(1), message(2)] }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    const page = await client.getMessages(5, 12, 100);

    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages?limit=100&beforeId=12");
    expect(page.map((entry) => entry.id)).toEqual([1, 2]);

    const bare = await client.getMessages(5);
    expect(fake.requests[1]?.path).toBe("/api/channels/5/messages");
    expect(bare).toHaveLength(2);
  });

  it("sendMessage POSTs the create body verbatim", async () => {
    const fake = new FakeFetch(() => ({ status: 201, body: message(3) }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    const created = await client.sendMessage(5, { content: "hi there", replyToId: 2 });

    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages");
    expect(fake.requests[0]?.body).toEqual({ content: "hi there", replyToId: 2 });
    expect(created.id).toBe(3);
  });

  it("pin/unpin/pinned hit the pin routes with the right verbs", async () => {
    const pinned = { ...message(3), pinned: true, pinnedBy: "alice", pinnedAt: "2026-09-22T00:00:00Z" };
    const fake = new FakeFetch(() => ({ status: 200, body: pinned }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    await client.pinMessage(5, 3);
    await client.unpinMessage(5, 3);
    await client.getPinnedMessages(5);

    expect(fake.requests[0]?.method).toBe("PUT");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages/3/pin");
    expect(fake.requests[1]?.method).toBe("DELETE");
    expect(fake.requests[1]?.path).toBe("/api/channels/5/messages/3/pin");
    expect(fake.requests[2]?.method).toBe("GET");
    expect(fake.requests[2]?.path).toBe("/api/channels/5/messages/pinned");
  });

  it("createChannel / renameChannel / deleteChannel hit the exact routes", async () => {
    const fake = new FakeFetch((request) => {
      if (request.method === "POST" && request.path === "/api/channels") {
        return { status: 201, body: { id: 9, name: "lounge", type: "TEXT", createdAt: "t", locked: false } };
      }
      if (request.method === "PATCH" && request.path === "/api/channels/9/name") {
        return { status: 200, body: { id: 9, name: "the lounge", type: "TEXT", createdAt: "t", locked: false } };
      }
      if (request.method === "DELETE" && request.path === "/api/channels/9") {
        return { status: 204 };
      }
      return { status: 500, body: { message: `unexpected ${request.method} ${request.path}` } };
    });
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    await client.createChannel({ name: "lounge", type: "TEXT" });
    expect(fake.requests[0]?.body).toEqual({ name: "lounge", type: "TEXT" });

    const renamed = await client.renameChannel(9, "the lounge");
    expect(fake.requests[1]?.method).toBe("PATCH");
    expect(fake.requests[1]?.path).toBe("/api/channels/9/name"); // NOT PATCH /9 — that is the DM route
    expect(fake.requests[1]?.body).toEqual({ name: "the lounge" });
    expect(renamed.name).toBe("the lounge");

    await client.deleteChannel(9);
    expect(fake.requests[2]?.method).toBe("DELETE");
    expect(fake.requests[2]?.path).toBe("/api/channels/9");
  });

  it("getServerProfile parses the profile shape", async () => {
    const fake = new FakeFetch(() => ({
      status: 200,
      body: { id: 1, name: "Oak HQ", avatarKey: null, avatarUrl: null, connectionHost: null, connectionPort: null },
    }));
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    const profile = await client.getServerProfile();
    expect(fake.requests[0]?.path).toBe("/api/server");
    expect(profile.name).toBe("Oak HQ");
  });

  it("viewer permission endpoints: server-wide set and per-channel override bits", async () => {
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/users/me/permissions") {
        return { status: 200, body: { permissions: ["SEND_MESSAGES", "MANAGE_CHANNELS"], owner: false } };
      }
      if (request.path === "/api/channels/7/permissions/me") {
        return { status: 200, body: { sendMessages: false, attachFiles: false } };
      }
      return { status: 500, body: { message: `unexpected ${request.path}` } };
    });
    const client = new RestClient({
      baseUrl: "http://x",
      tokenStorage: new MemoryTokenStorage(),
      fetchImpl: fake.call,
    });

    const myPermissions = await client.getMyPermissions();
    expect(myPermissions.permissions).toContain("MANAGE_CHANNELS");
    expect(myPermissions.owner).toBe(false);

    const channelPermissions = await client.getChannelMyPermissions(7);
    expect(channelPermissions.sendMessages).toBe(false); // the composer gate
  });
});
