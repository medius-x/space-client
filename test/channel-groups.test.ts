import { describe, expect, it } from "vitest";
import {
  compareChannelOrder,
  flattenGroupsForPersist,
  groupChannelsByCategory,
} from "../src/domain/logic/channel-groups";
import type { Channel } from "../src/types";

let nextId = 1;
function channel(overrides: Partial<Channel> & { name: string; type: Channel["type"] }): Channel {
  return {
    id: overrides.id ?? nextId++,
    createdAt: "2026-10-01T00:00:00Z",
    locked: false,
    parentId: null,
    position: 0,
    ...overrides,
  };
}
function category(name: string, position: number): Channel {
  return channel({ name, type: "CATEGORY", position });
}

describe("compareChannelOrder", () => {
  it("orders by position first, id breaking ties", () => {
    expect(compareChannelOrder(
      channel({ id: 9, name: "a", type: "TEXT", position: 1 }),
      channel({ id: 2, name: "b", type: "TEXT", position: 2 }),
    )).toBeLessThan(0);
    expect(compareChannelOrder(
      channel({ id: 2, name: "a", type: "TEXT", position: 5 }),
      channel({ id: 9, name: "b", type: "TEXT", position: 5 }),
    )).toBeLessThan(0);
  });
});

describe("groupChannelsByCategory", () => {
  it("splits uncategorized text/voice and category children (text above voice)", () => {
    const games = channel({ id: 10, name: "Games", type: "CATEGORY", position: 1 });
    const groups = groupChannelsByCategory([
      channel({ id: 5, name: "lobby", type: "VOICE", parentId: 10 }),
      channel({ id: 3, name: "general", type: "TEXT", parentId: 10 }),
      channel({ id: 1, name: "news", type: "TEXT" }),
      channel({ id: 2, name: "random", type: "TEXT" }),
      games,
      channel({ id: 4, name: "music", type: "VOICE" }),
    ]);

    expect(groups.uncategorizedText.map((entry) => entry.name)).toEqual(["news", "random"]);
    expect(groups.uncategorizedVoice.map((entry) => entry.name)).toEqual(["music"]);
    expect(groups.categories).toHaveLength(1);
    expect(groups.categories[0]!.category.name).toBe("Games");
    expect(groups.categories[0]!.textChannels.map((entry) => entry.name)).toEqual(["general"]);
    expect(groups.categories[0]!.voiceChannels.map((entry) => entry.name)).toEqual(["lobby"]);
  });

  it("sorts everything by (position, id), not by input order", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 7, name: "z-late", type: "TEXT", position: 9 }),
      channel({ id: 6, name: "a-early", type: "TEXT", position: 1 }),
      channel({ id: 5, name: "catB", type: "CATEGORY", position: 2 }),
      channel({ id: 4, name: "catA", type: "CATEGORY", position: 1 }),
    ]);
    expect(groups.uncategorizedText.map((entry) => entry.name)).toEqual(["a-early", "z-late"]);
    expect(groups.categories.map((group) => group.category.name)).toEqual(["catA", "catB"]);
  });

  it("falls back a child of an INVISIBLE category to uncategorized", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 1, name: "hidden-child", type: "TEXT", parentId: 999 }),
    ]);
    expect(groups.uncategorizedText.map((entry) => entry.name)).toEqual(["hidden-child"]);
    expect(groups.categories).toHaveLength(0);
  });
});

describe("flattenGroupsForPersist", () => {
  it("walks uncategorized first, then each category row followed by its children", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 1, name: "news", type: "TEXT", position: 0 }),
      channel({ id: 2, name: "lobby-uncat", type: "VOICE", position: 1 }),
      channel({ id: 3, name: "Games", type: "CATEGORY", position: 2 }),
      channel({ id: 4, name: "lounge", type: "VOICE", parentId: 3 }),
      channel({ id: 5, name: "general", type: "TEXT", parentId: 3 }),
    ]);
    expect(flattenGroupsForPersist(groups)).toEqual([
      { id: 1, parentId: null },
      { id: 2, parentId: null },
      { id: 3, parentId: null },
      { id: 5, parentId: 3 },
      { id: 4, parentId: 3 },
    ]);
  });

  it("round-trips: flatten → dense renumber → the same block structure", () => {
    const original = groupChannelsByCategory([
      channel({ id: 1, name: "news", type: "TEXT", position: 0 }),
      channel({ id: 2, name: "Games", type: "CATEGORY", position: 1 }),
      channel({ id: 3, name: "general", type: "TEXT", parentId: 2 }),
      channel({ id: 4, name: "lobby", type: "VOICE", parentId: 2 }),
      channel({ id: 5, name: "music", type: "VOICE", position: 4 }),
    ]);
    const flattened = flattenGroupsForPersist(original);
    const byId = new Map([
      ...original.uncategorizedText,
      ...original.uncategorizedVoice,
      ...original.categories.flatMap((group) => [group.category, ...group.textChannels, ...group.voiceChannels]),
    ].map((channelEntry) => [channelEntry.id, channelEntry]));
    // The server renumbers positions by list index — simulate that and regroup.
    const renumbered = flattened.map((entry, index) =>
      ({ ...byId.get(entry.id)!, position: index, parentId: entry.parentId }));
    const again = groupChannelsByCategory(renumbered);
    expect(again.uncategorizedText.map((entry) => entry.id)).toEqual(original.uncategorizedText.map((entry) => entry.id));
    expect(again.uncategorizedVoice.map((entry) => entry.id)).toEqual(original.uncategorizedVoice.map((entry) => entry.id));
    expect(again.categories.map((group) => group.category.id)).toEqual(original.categories.map((group) => group.category.id));
    expect(again.categories.flatMap((group) => group.textChannels.map((entry) => entry.id)))
      .toEqual(original.categories.flatMap((group) => group.textChannels.map((entry) => entry.id)));
    expect(again.categories.flatMap((group) => group.voiceChannels.map((entry) => entry.id)))
      .toEqual(original.categories.flatMap((group) => group.voiceChannels.map((entry) => entry.id)));
  });
});
