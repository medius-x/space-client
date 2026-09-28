import { describe, expect, it } from "vitest";
import { EmojiStore } from "../src/domain/stores/EmojiStore";
import type { CustomEmoji } from "../src/types";

function emojiOf(id: number, name: string): CustomEmoji {
  return { id, name, url: `http://minio/${name}.png`, key: `custom-emojis/u/${name}.png`, uploadedBy: 1 };
}

describe("EmojiStore (the live custom-emoji catalog)", () => {
  it("applySnapshot sorts by name and exposes the derived lookups in the snapshot", () => {
    const store = new EmojiStore();
    store.applySnapshot([emojiOf(2, "zebra"), emojiOf(1, "cat")]);
    const snapshot = store.getSnapshot();
    expect(snapshot.emojis.map((emoji) => emoji.name)).toEqual(["cat", "zebra"]);
    expect([...snapshot.names]).toEqual(["cat", "zebra"]);
    expect(snapshot.byName.get("cat")?.id).toBe(1);
  });

  it("the derived set/map keep IDENTITY between snapshots (the useStore contract)", () => {
    const store = new EmojiStore();
    store.applySnapshot([emojiOf(1, "cat")]);
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(second.names).toBe(first.names);
    expect(second.byName).toBe(first.byName);
  });

  it("a new snapshot rebuilds the lookups — a fresh name appears, a gone one disappears", () => {
    const store = new EmojiStore();
    store.applySnapshot([emojiOf(1, "cat")]);
    store.applySnapshot([emojiOf(2, "doge")]);
    const snapshot = store.getSnapshot();
    expect(snapshot.names.has("cat")).toBe(false);
    expect(snapshot.names.has("doge")).toBe(true);
    expect(snapshot.byName.get("doge")?.id).toBe(2);
  });

  it("markUnsupported empties the catalog and flags the server as feature-less", () => {
    const store = new EmojiStore();
    store.applySnapshot([emojiOf(1, "cat")]);
    store.markUnsupported();
    const snapshot = store.getSnapshot();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.emojis).toEqual([]);
    expect(snapshot.names.size).toBe(0);
  });
});
