import { describe, expect, it } from "vitest";
import { RestClient } from "../src/core/rest";
import { MemoryTokenStorage } from "../src/core/auth";
import { FakeFetch } from "./mocks/fake-fetch";
import type { Message } from "../src/types";

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

/** Wire contracts for the M2 mutation endpoints. */
describe("RestClient message mutations", () => {
  it("editMessage PATCHes {content} to the message route", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: message(3) }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    const edited = await client.editMessage(5, 3, { content: "new text" });

    expect(fake.requests[0]?.method).toBe("PATCH");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages/3");
    expect(fake.requests[0]?.body).toEqual({ content: "new text" });
    expect(edited.id).toBe(3);
  });

  it("deleteMessage DELETEs and tolerates the 204", async () => {
    const fake = new FakeFetch(() => ({ status: 204 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.deleteMessage(5, 3);
    expect(fake.requests[0]?.method).toBe("DELETE");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages/3");
  });

  it("void endpoints tolerate Spring's 200-with-empty-body (remove/ban/unban)", async () => {
    // A void controller method answers 200 with NO body — not 204. response.json()
    // used to throw "Unexpected end of JSON input" after the action had already
    // landed (live report on banMember).
    const fake = new FakeFetch(() => ({ status: 200 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.banMember(7);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/members/7/ban");
  });

  it("removeMember POSTs the permanent-removal route", async () => {
    const fake = new FakeFetch(() => ({ status: 200 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.removeMember(7);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/members/7/remove");
  });

  it("reactions PUT/DELETE the slug route and return the snapshot", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: [{ reaction: "heart", count: 1, userIds: [10], usernames: ["alice"] }] }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.addReaction(5, 3, "heart");
    expect(fake.requests[0]?.method).toBe("PUT");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages/3/reactions/heart");

    const snapshot = await client.removeReaction(5, 3, "heart");
    expect(fake.requests[1]?.method).toBe("DELETE");
    expect(snapshot[0]?.reaction).toBe("heart");
  });

  it("a custom-emoji reaction slug rides the path percent-encoded", async () => {
    // ":cat:" must reach the wire as %3Acat%3A — colons are legal path characters,
    // but the encoding pins the contract (the server's @PathVariable decodes it back).
    const fake = new FakeFetch(() => ({ status: 200, body: [] }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.addReaction(5, 3, ":cat:");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages/3/reactions/%3Acat%3A");

    await client.removeReaction(5, 3, ":cat:");
    expect(fake.requests[1]?.path).toBe("/api/channels/5/messages/3/reactions/%3Acat%3A");
  });

  it("forwardMessage POSTs the two modes verbatim", async () => {
    const fake = new FakeFetch(() => ({ status: 201, body: message(9) }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.forwardMessage(6, { sourceMessageId: 3, content: null });
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/channels/6/messages/forward");
    expect(fake.requests[0]?.body).toEqual({ sourceMessageId: 3, content: null });

    await client.forwardMessage(6, {
      sourceMessageId: null,
      content: "comment",
      originServer: "Other",
      originChannel: "general",
      originAuthorId: 77,
      originAuthorName: "carol",
      originCreatedAt: "2026-01-01T00:00:00Z",
      originReply: null,
    });
    expect(fake.requests[1]?.body).toMatchObject({ sourceMessageId: null, originServer: "Other" });
  });

  it("read-states: snapshot GET, ack with pointer body or empty body", async () => {
    const fake = new FakeFetch((request) => {
      if (request.path === "/api/read-states") {
        return { status: 200, body: [{ channelId: 5, unreadCount: 2, mentionCount: 1, lastReadMessageId: 3, lastMessageId: 9 }] };
      }
      return { status: 204 };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    const states = await client.getReadStates();
    expect(states[0]?.mentionCount).toBe(1);

    await client.ackChannelRead(5, 9);
    expect(fake.requests[1]?.body).toEqual({ lastReadMessageId: 9 });

    await client.ackChannelRead(5, null); // "mark all read" → EMPTY body
    expect(fake.requests[2]?.body).toBeNull();
  });
});

/** Wire contracts for the custom-emoji catalog (phase 1). */
describe("RestClient custom emojis", () => {
  it("getEmojis returns null on 404 — an older server hides the feature", async () => {
    const fake = new FakeFetch(() => ({ status: 404, body: { message: "no route" } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    expect(await client.getEmojis()).toBeNull();
  });

  it("the two-phase upload: slot POSTs {fileName}, create POSTs {name, fileKey}", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { id: 1, name: "cat", url: null, key: "custom-emojis/u/cat.png", uploadedBy: 2 } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.requestEmojiUploadSlot("cat.png");
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/emojis/slot");
    expect(fake.requests[0]?.body).toEqual({ fileName: "cat.png" });

    await client.createEmoji({ name: "cat", fileKey: "custom-emojis/u/cat.png" });
    expect(fake.requests[1]?.method).toBe("POST");
    expect(fake.requests[1]?.path).toBe("/api/emojis");
    expect(fake.requests[1]?.body).toEqual({ name: "cat", fileKey: "custom-emojis/u/cat.png" });
  });

  it("deleteEmoji DELETEs the row route", async () => {
    const fake = new FakeFetch(() => ({ status: 204 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.deleteEmoji(7);
    expect(fake.requests[0]?.method).toBe("DELETE");
    expect(fake.requests[0]?.path).toBe("/api/emojis/7");
  });
});

/** Wire contracts for the custom-sticker catalog (phase 2). */
describe("RestClient stickers", () => {
  it("getStickerPacks returns null on 404 — an older server hides the feature", async () => {
    const fake = new FakeFetch(() => ({ status: 404, body: { message: "no route" } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    expect(await client.getStickerPacks()).toBeNull();
  });

  it("pack create/delete hit the pack routes with the exact bodies", async () => {
    const fake = new FakeFetch(() => ({ status: 204 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.createStickerPack("Cats");
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/sticker-packs");
    expect(fake.requests[0]?.body).toEqual({ name: "Cats" });

    await client.deleteStickerPack(3);
    expect(fake.requests[1]?.method).toBe("DELETE");
    expect(fake.requests[1]?.path).toBe("/api/sticker-packs/3");
  });

  it("the two-phase upload: slot POSTs {fileName}, create POSTs {name, packId, fileKey}", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { id: 1, name: "cat", url: null, key: "stickers/u/cat.png", uploadedBy: 2 } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.requestStickerUploadSlot("cat.png");
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/stickers/slot");
    expect(fake.requests[0]?.body).toEqual({ fileName: "cat.png" });

    await client.createSticker({ name: "cat", packId: 5, fileKey: "stickers/u/cat.png" });
    expect(fake.requests[1]?.method).toBe("POST");
    expect(fake.requests[1]?.path).toBe("/api/stickers");
    expect(fake.requests[1]?.body).toEqual({ name: "cat", packId: 5, fileKey: "stickers/u/cat.png" });
  });

  it("deleteSticker DELETEs the row route", async () => {
    const fake = new FakeFetch(() => ({ status: 204 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.deleteSticker(9);
    expect(fake.requests[0]?.method).toBe("DELETE");
    expect(fake.requests[0]?.path).toBe("/api/stickers/9");
  });

  it("sendMessage with a sticker posts the exact tray-send body", async () => {
    const fake = new FakeFetch(() => ({ status: 201, body: message(31) }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.sendMessage(5, { content: null, stickerId: 9, replyToId: null, idempotencyKey: "key-1" });
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/channels/5/messages");
    expect(fake.requests[0]?.body).toEqual({ content: null, stickerId: 9, replyToId: null, idempotencyKey: "key-1" });
  });
});

describe("RestClient invites", () => {
  /** A fetch fake whose register answers 201-with-user and login answers a token pair —
   *  client.register() logs straight in (the spike UX), so both calls are expected. */
  function registerFake(): FakeFetch {
    return new FakeFetch((request) => request.path === "/api/auth/login"
      ? { status: 200, body: { token: "t", refreshToken: "r", tokenType: "Bearer", expiresIn: 100 } }
      : { status: 201, body: { id: 7, username: "u", createdAt: "2026-09-30T00:00:00Z", avatarKey: null, avatarUrl: null, displayName: "u" } });
  }

  it("register without options keeps the legacy two-field body", async () => {
    const fake = registerFake();
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.register("alice", "supersecret");
    expect(fake.requests[0]?.path).toBe("/api/auth/register");
    expect(fake.requests[0]?.body).toEqual({ username: "alice", password: "supersecret" });
  });

  it("register with an invite carries the nickname and the secret, then logs in", async () => {
    const fake = registerFake();
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.register("alice", "supersecret", { nickname: "Alice", inviteSecret: "sec-ret" });
    expect(fake.requests[0]?.body).toEqual({ username: "alice", password: "supersecret", nickname: "Alice", inviteSecret: "sec-ret" });
    expect(fake.requests[1]?.path).toBe("/api/auth/login");
  });

  it("the invites section: status GET, mint POST, revoke DELETE, expire-all POST, TTL PUT", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { ttlHours: 24, invites: [] } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.getInvites();
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/invites");

    await client.createInvite();
    expect(fake.requests[1]?.method).toBe("POST");
    expect(fake.requests[1]?.path).toBe("/api/invites");

    await client.revokeInvite(4);
    expect(fake.requests[2]?.method).toBe("DELETE");
    expect(fake.requests[2]?.path).toBe("/api/invites/4");

    await client.expireAllInvites();
    expect(fake.requests[3]?.method).toBe("POST");
    expect(fake.requests[3]?.path).toBe("/api/invites/expire-all");

    await client.updateInviteSettings(525600);
    expect(fake.requests[4]?.method).toBe("PUT");
    expect(fake.requests[4]?.path).toBe("/api/server/invite-settings");
    expect(fake.requests[4]?.body).toEqual({ ttlMinutes: 525600 });
  });
});

describe("RestClient ownership transfer", () => {
  it("pending GET, offer POST body, accept/decline/cancel routes", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { pending: null } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.getPendingOwnershipTransfer();
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/ownership/pending");

    await client.offerOwnershipTransfer(7);
    expect(fake.requests[1]?.method).toBe("POST");
    expect(fake.requests[1]?.path).toBe("/api/ownership/offer");
    expect(fake.requests[1]?.body).toEqual({ toUserId: 7 });

    await client.acceptOwnershipTransfer(5);
    expect(fake.requests[2]?.method).toBe("POST");
    expect(fake.requests[2]?.path).toBe("/api/ownership/5/accept");

    await client.declineOwnershipTransfer(5);
    expect(fake.requests[3]?.method).toBe("POST");
    expect(fake.requests[3]?.path).toBe("/api/ownership/5/decline");

    await client.cancelOwnershipTransfer(5);
    expect(fake.requests[4]?.method).toBe("POST");
    expect(fake.requests[4]?.path).toBe("/api/ownership/5/cancel");
  });
});

describe("RestClient AFK settings", () => {
  it("reads and writes the sweep settings", async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: { afkChannelId: 3, afkTimeoutMinutes: 15 } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.getAfkSettings();
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/server/afk");

    await client.updateAfkSettings(null, 15);
    expect(fake.requests[1]?.method).toBe("PUT");
    expect(fake.requests[1]?.path).toBe("/api/server/afk");
    expect(fake.requests[1]?.body).toEqual({ afkChannelId: null, afkTimeoutMinutes: 15 });
  });
});

describe("RestClient server logs download", () => {
  it("downloads the archive bytes with the Bearer header", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 1, 2, 3]);
    const fake = new FakeFetch(() => ({ status: 200, rawBody: zipBytes }));
    const tokens = new MemoryTokenStorage();
    tokens.save({ token: "t1", refreshToken: "r1", expiresAt: Date.now() + 3_600_000 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: tokens, fetchImpl: fake.call });

    const archive = await client.downloadServerLogs();

    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/server/logs");
    expect(fake.requests[0]?.authorization).toBe("Bearer t1");
    expect(Array.from(archive.slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it("surfaces a rejection as ApiError (the gate answers JSON)", async () => {
    const fake = new FakeFetch(() => ({ status: 403, body: { status: 403, error: "Forbidden", message: "no" } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await expect(client.downloadServerLogs()).rejects.toMatchObject({ status: 403, message: "no" });
  });
});

describe("RestClient server health", () => {
  it("fetches the typed health snapshot with the Bearer header", async () => {
    const snapshot = {
      checkedAt: "2026-10-07T12:00:00Z",
      services: [
        {
          name: "postgres",
          service: { status: "UP", latencyMillis: 3, detail: null },
          container: { status: "RUNNING", health: "HEALTHY", detail: "Up 2 hours (healthy)" },
        },
        {
          name: "janus",
          service: { status: "DOWN", latencyMillis: null, detail: "Connection refused" },
          container: { status: "EXITED", health: "NONE", detail: "Exited (1) 2 minutes ago" },
        },
        // A provisioned server sends NO container side at all (oak runs in a
        // container without the host's docker socket) — null on the wire.
        {
          name: "coturn",
          service: { status: "UP", latencyMillis: 1, detail: null },
          container: null,
        },
      ],
    };
    const fake = new FakeFetch(() => ({ status: 200, body: snapshot }));
    const tokens = new MemoryTokenStorage();
    tokens.save({ token: "t1", refreshToken: "r1", expiresAt: Date.now() + 3_600_000 });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: tokens, fetchImpl: fake.call });

    const health = await client.fetchServerHealth();

    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe("/api/server/health");
    expect(fake.requests[0]?.authorization).toBe("Bearer t1");
    expect(health.services).toHaveLength(3);
    expect(health.services[1]?.name).toBe("janus");
    expect(health.services[1]?.service.status).toBe("DOWN");
    expect(health.services[0]?.container?.health).toBe("HEALTHY");
    expect(health.services[2]?.container).toBeNull();
  });

  it("surfaces the gate rejection as ApiError", async () => {
    const fake = new FakeFetch(() => ({ status: 403, body: { status: 403, error: "Forbidden", message: "Missing permission" } }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await expect(client.fetchServerHealth()).rejects.toMatchObject({ status: 403, message: "Missing permission" });
  });
});
