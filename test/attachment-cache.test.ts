import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentCache, dormantAttachmentCache } from "../src/media/attachment-cache";

/** In-memory stand-in for the main-process disk bridge (the renderer reaches it
 *  through window.spaceMedia, which does not exist in the node test env). */
function stubDiskBridge(): { disk: Map<string, Uint8Array> } {
  const disk = new Map<string, Uint8Array>();
  vi.stubGlobal("window", {
    spaceMedia: {
      cachePut: async (key: string, bytes: Uint8Array) => {
        disk.set(key, bytes);
      },
      cacheGet: async (key: string) => disk.get(key) ?? null,
      cacheTrim: async () => undefined,
    },
  });
  return { disk };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AttachmentCache dormant reads (offline rail icons)", () => {
  it("a null-URL image loads from disk alone — no session, no network", async () => {
    // The offline-startup rail path: `rest: () => null` (no live RestClient) and
    // `url: null` (no session mints presigned URLs) — the shared main-process
    // disk cache is the only possible source, and it is enough.
    const { disk } = stubDiskBridge();
    disk.set("server-icons/one", new Uint8Array([1, 2, 3]));
    const cache = new AttachmentCache(() => null);
    const url = await cache.loadImage({ key: "server-icons/one", url: null });
    expect(url).toEqual(expect.stringMatching(/^blob:/));
  });

  it("a disk miss with a null URL resolves null — no fallback fetch exists", async () => {
    stubDiskBridge();
    const cache = new AttachmentCache(() => null);
    expect(await cache.loadImage({ key: "missing", url: null })).toBeNull();
  });

  it("memory-only mode (budget 0) skips the disk layer entirely", async () => {
    const { disk } = stubDiskBridge();
    disk.set("server-icons/two", new Uint8Array([9]));
    const cache = new AttachmentCache(() => null);
    cache.setDiskBudget(0);
    expect(await cache.loadImage({ key: "server-icons/two", url: null })).toBeNull();
  });

  it("dormantAttachmentCache() hands out one shared instance", () => {
    expect(dormantAttachmentCache()).toBe(dormantAttachmentCache());
  });
});
