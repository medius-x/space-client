import { describe, expect, it } from "vitest";
import { RestClient } from "../src/core/rest";
import { MemoryTokenStorage } from "../src/core/auth";
import { FakeFetch } from "./mocks/fake-fetch";

/** Wire contracts for the M3 upload/avatar/link endpoints. */
describe("RestClient attachments & avatars (M3)", () => {
  it("two-phase upload: mint a slot, PUT bytes to MinIO without auth", async () => {
    const fake = new FakeFetch((request) => {
      if (request.method === "POST" && request.path === "/api/attachments") {
        return { status: 200, body: { key: "uploads/abc.png", uploadUrl: "http://minio/put?sig=1" } };
      }
      if (request.url.startsWith("http://minio/put")) {
        return { status: 200, body: "" };
      }
      return { status: 500, body: { message: "unexpected" } };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    const slot = await client.requestAttachmentUpload("pic.png");
    expect(fake.requests[0]?.body).toEqual({ fileName: "pic.png" });
    expect(slot.key).toBe("uploads/abc.png");

    await client.uploadBytes(slot.uploadUrl, new ArrayBuffer(4), "image/png");
    expect(fake.requests[1]?.method).toBe("PUT");
    expect(fake.requests[1]?.url).toBe("http://minio/put?sig=1");
    expect(fake.requests[1]?.authorization).toBeNull(); // presigned carries the auth
  });

  it("freshAttachmentLink encodes the key and maps 404 → null", async () => {
    const fake = new FakeFetch((request) => {
      if (request.path.startsWith("/api/attachments/link")) {
        if (request.path.includes("gone")) {
          return { status: 404, body: { message: "nope" } };
        }
        return { status: 200, body: { url: "http://minio/fresh?sig=2" } };
      }
      return { status: 500, body: { message: "unexpected" } };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    const fresh = await client.freshAttachmentLink("a/b c.png");
    expect(fake.requests[0]?.path).toBe("/api/attachments/link?key=a%2Fb%20c.png");
    expect(fresh).toBe("http://minio/fresh?sig=2");

    expect(await client.freshAttachmentLink("gone-key")).toBeNull();
  });

  it("avatar lifecycle: slots, confirm body, remove, lazy original", async () => {
    const fake = new FakeFetch((request) => {
      if (request.method === "POST" && request.path === "/api/users/me/avatar") {
        return { status: 200, body: { key: "avatars/crop.png", uploadUrl: "http://m/crop" } };
      }
      if (request.method === "POST" && request.path === "/api/users/me/avatar/original") {
        return { status: 200, body: { key: "avatars/orig.png", uploadUrl: "http://m/orig" } };
      }
      if (request.method === "POST" && request.path === "/api/users/me/avatar/confirm") {
        const confirmBody = request.body as { avatarKey: string };
        return { status: 200, body: { id: 1, username: "alice", createdAt: "t", avatarKey: confirmBody.avatarKey, avatarUrl: null } };
      }
      if (request.method === "DELETE" && request.path === "/api/users/me/avatar") {
        return { status: 200, body: { id: 1, username: "alice", createdAt: "t", avatarKey: null, avatarUrl: null } };
      }
      if (request.method === "GET" && request.path === "/api/users/me/avatar/original") {
        return { status: 200, body: { url: "http://m/orig-get" } };
      }
      return { status: 500, body: { message: `unexpected ${request.method} ${request.path}` } };
    });
    const client = new RestClient({ baseUrl: "http://x", tokenStorage: new MemoryTokenStorage(), fetchImpl: fake.call });

    await client.requestAvatarUpload("avatar.png");
    await client.requestAvatarOriginalUpload("avatar.png");
    const confirmed = await client.confirmAvatar("avatars/crop.png", "avatars/orig.png");
    expect(fake.requests[2]?.body).toEqual({ avatarKey: "avatars/crop.png", originalKey: "avatars/orig.png" });
    expect(confirmed.avatarKey).toBe("avatars/crop.png");

    // Re-crop keeps the stored original: null originalKey.
    await client.confirmAvatar("avatars/crop2.png", null);
    expect(fake.requests[3]?.body).toEqual({ avatarKey: "avatars/crop2.png", originalKey: null });

    await client.removeAvatar();
    expect(await client.getAvatarOriginalUrl()).toBe("http://m/orig-get");
  });
});
