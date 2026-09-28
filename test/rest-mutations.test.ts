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

  it("void endpoints tolerate Spring's 200-with-empty-body (kick/ban/unban)", async () => {
    // A void controller method answers 200 with NO body — not 204. response.json()
    // used to throw "Unexpected end of JSON input" after the action had already
    // landed (live report on banMember).
    const fake = new FakeFetch(() => ({ status: 200 }));
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.banMember(7);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/api/members/7/ban");
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
