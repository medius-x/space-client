import { describe, expect, it } from "vitest";
import { GameStore } from "../src/domain/stores/GameStore";
import type { GameCard } from "../src/types";

const card = (igdbId: number, iconUrl?: string | null): GameCard => ({
  igdbId,
  name: `Game ${igdbId}`,
  coverImageId: "co1",
  genres: [],
  firstReleaseDate: null,
  iconUrl: iconUrl ?? null,
});

describe("GameStore.applyCards (the icon upgrade rule, V23)", () => {
  it("adds unknown cards and ignores re-seeing a fully known one", () => {
    const store = new GameStore();
    store.applyCards([card(1)]);
    store.applyCards([card(1)]);
    expect(store.getSnapshot().cards.size).toBe(1);
  });

  it("a cached card is upgraded ONLY by an answer carrying an icon", () => {
    const store = new GameStore();
    store.applyCards([card(1)]);
    const first = store.getSnapshot().cards.get(1);

    store.applyCards([card(1)]); // still no icon — same reference, no emit churn
    expect(store.getSnapshot().cards.get(1)).toBe(first);

    store.applyCards([card(1, "https://cdn/icon.png")]);
    expect(store.getSnapshot().cards.get(1)?.iconUrl).toBe("https://cdn/icon.png");
  });

  it("an icon already cached is never downgraded by an icon-less answer", () => {
    const store = new GameStore();
    store.applyCards([card(1, "https://cdn/icon.png")]);
    store.applyCards([card(1)]);
    expect(store.getSnapshot().cards.get(1)?.iconUrl).toBe("https://cdn/icon.png");
  });
});

describe("GameStore.applyIcon (the bytes leg, V23)", () => {
  it("lands an icon object URL and re-lands the same one silently", () => {
    const store = new GameStore();
    store.applyIcon(1, "blob:first");
    expect(store.getSnapshot().icons.get(1)).toBe("blob:first");
    store.applyIcon(1, "blob:first"); // same URL — no churn, still there
    expect(store.getSnapshot().icons.get(1)).toBe("blob:first");
    store.applyIcon(1, "blob:second");
    expect(store.getSnapshot().icons.get(1)).toBe("blob:second");
  });
});
