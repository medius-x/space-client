import { describe, expect, it } from "vitest";
import { GameStore } from "../src/domain/stores/GameStore";
import type { GameCard } from "../src/types";

const card = (igdbId: number, name: string): GameCard => ({
  igdbId,
  name,
  coverImageId: null,
  genres: [],
  firstReleaseDate: null,
});

describe("GameStore.applyCards (new ids only)", () => {
  it("adds unknown cards exactly once — a re-delivery of a known card is a no-op", () => {
    const store = new GameStore();
    const first = card(1, "Wardogs");
    store.applyCards([first]);
    expect(store.getSnapshot().cards.get(1)?.name).toBe("Wardogs");
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    store.applyCards([first]);
    expect(emissions).toBe(0); // no churn, no re-render
  });

  it("lands cover object URLs for the corner picture", () => {
    const store = new GameStore();
    store.applyCover(7, "blob:cover");
    expect(store.getSnapshot().covers.get(7)).toBe("blob:cover");
  });
});
