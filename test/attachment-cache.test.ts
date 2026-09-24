import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentCache, dormantAttachmentCache } from "../src/media/attachment-cache";

/** A rest stand-in whose only job is minting fresh links on demand. */
function restWithMint(mint: () => string | null): { freshAttachmentLink(key: string): Promise<string | null> } {
  return {
    freshAttachmentLink: async () => mint(),
  };
}

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

  it("a 404 verified against a fresh mint kills the key for the session", async () => {
    // The scroll-freeze regression: the virtual list remounts rows on every
    // pass, and a dead object re-ran the whole fetch chain each time.
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new AttachmentCache(() => restWithMint(() => "http://minio/fresh") as never);
    expect(await cache.loadImage({ key: "dead/video", url: "http://minio/row" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // row link 404 → fresh mint → 404 again
    await cache.loadImage({ key: "dead/video", url: "http://minio/row" });
    await cache.loadImage({ key: "dead/video", url: null }); // even disk-only path is silent
    expect(fetchMock).toHaveBeenCalledTimes(2); // no further traffic this session
  });

  it("a 404 with no mint available still kills the key (dormant-style)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new AttachmentCache(() => null);
    expect(await cache.loadImage({ key: "gone", url: "http://minio/row" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cache.loadImage({ key: "gone", url: "http://minio/row" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a transient failure only backs off — the retry goes out after the window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network is down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new AttachmentCache(() => restWithMint(() => "http://minio/fresh") as never);
    expect(await cache.loadImage({ key: "flaky", url: "http://minio/row" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // two attempts with a mint between
    await cache.loadImage({ key: "flaky", url: "http://minio/row" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // inside the backoff — silent
    vi.advanceTimersByTime(31_000);
    await cache.loadImage({ key: "flaky", url: "http://minio/row" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // the window passed — full retry
    vi.useRealTimers();
  });

  it("a null-URL row NEVER mints — /attachments/link 404s server icons (memory-only cache)", async () => {
    // Regression guard: minting for url-null rows poisoned server-icon keys
    // with backoff loops — the link endpoint validates MESSAGE attachments
    // only, so an avatar key always mint-404s. The URL must arrive with the
    // server profile instead (sessionsIndex re-render path).
    stubDiskBridge();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([7, 7, 7])));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new AttachmentCache(() => restWithMint(() => "http://minio/minted") as never);
    cache.setDiskBudget(0); // memory-only — the disk layer is off entirely
    expect(await cache.loadImage({ key: "server-avatars/x/icon.png", url: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // no mint, no fetch, no backoff noise
  });
});
