import { describe, expect, it } from "vitest";
import { DownloadsStore } from "../src/domain/stores/DownloadsStore";
import { kv } from "../src/domain/persistence/kv-client";

describe("DownloadsStore", () => {
  it("remembers a saved path and survives a reload (the registry persists)", async () => {
    await kv.set("downloaded-files", {}); // isolate from other tests via the shared fallback
    const store = new DownloadsStore();
    store.markDownloaded("attachments/uuid-1/report.pdf", "C:/Users/Tester/Downloads/SPACE/report.pdf");
    expect(store.pathFor("attachments/uuid-1/report.pdf")).toBe("C:/Users/Tester/Downloads/SPACE/report.pdf");
    expect(store.pathFor("attachments/uuid-2/other.png")).toBeNull();

    const reloaded = new DownloadsStore();
    await reloaded.load();
    expect(reloaded.pathFor("attachments/uuid-1/report.pdf")).toBe("C:/Users/Tester/Downloads/SPACE/report.pdf");
  });

  it("forget drops the entry everywhere (the file vanished — back to Download)", async () => {
    await kv.set("downloaded-files", {});
    const store = new DownloadsStore();
    store.markDownloaded("attachments/uuid-3/clip.mp4", "C:/Users/Tester/Downloads/SPACE/clip.mp4");
    store.forget("attachments/uuid-3/clip.mp4");
    expect(store.pathFor("attachments/uuid-3/clip.mp4")).toBeNull();

    const reloaded = new DownloadsStore();
    await reloaded.load();
    expect(reloaded.pathFor("attachments/uuid-3/clip.mp4")).toBeNull();
  });

  it("a re-download of the same attachment replaces the remembered path", async () => {
    await kv.set("downloaded-files", {});
    const store = new DownloadsStore();
    store.markDownloaded("attachments/uuid-4/clip (1).mp4", "C:/Users/Tester/Downloads/SPACE/clip (1).mp4");
    store.markDownloaded("attachments/uuid-4/clip (2).mp4", "C:/Users/Tester/Downloads/SPACE/clip (2).mp4");
    expect(store.pathFor("attachments/uuid-4/clip (2).mp4")).toBe("C:/Users/Tester/Downloads/SPACE/clip (2).mp4");
  });

  it("load sanitizes hand-edited KV: non-string and empty paths drop out", async () => {
    await kv.set("downloaded-files", {
      "attachments/uuid-5/keep.txt": "C:/Users/Tester/Downloads/SPACE/keep.txt",
      "attachments/uuid-6/nullish.png": null,
      "attachments/uuid-7/number.jpg": 42,
      "attachments/uuid-8/empty.gif": "",
    });
    const store = new DownloadsStore();
    await store.load();
    expect(store.pathFor("attachments/uuid-5/keep.txt")).toBe("C:/Users/Tester/Downloads/SPACE/keep.txt");
    expect(store.pathFor("attachments/uuid-6/nullish.png")).toBeNull();
    expect(store.pathFor("attachments/uuid-7/number.jpg")).toBeNull();
    expect(store.pathFor("attachments/uuid-8/empty.gif")).toBeNull();
  });

  it("load resets on non-object KV garbage (an array or a string is not a registry)", async () => {
    await kv.set("downloaded-files", ["not", "an", "object"]);
    const arrayStore = new DownloadsStore();
    await arrayStore.load();
    expect(arrayStore.getSnapshot()).toEqual({});

    await kv.set("downloaded-files", "junk");
    const junkStore = new DownloadsStore();
    await junkStore.load();
    expect(junkStore.getSnapshot()).toEqual({});
  });
});
