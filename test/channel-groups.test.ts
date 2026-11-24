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

/** The ladder rendered as readable lines: "free:name" / "cat:name [text…, voice…]". */
function ladderOf(groups: ReturnType<typeof groupChannelsByCategory>): string[] {
  return groups.topLevel.map((node) => node.kind === "free"
    ? `free:${node.channel.name}`
    : `cat:${node.category.name} [${node.textChannels.map((entry) => entry.name)},${node.voiceChannels.map((entry) => entry.name)}]`);
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
  it("interleaves free channels and category blocks on ONE ladder (text above voice inside a block)", () => {
    const games = channel({ id: 10, name: "Games", type: "CATEGORY", position: 1 });
    const groups = groupChannelsByCategory([
      channel({ id: 5, name: "lobby", type: "VOICE", parentId: 10 }),
      channel({ id: 3, name: "general", type: "TEXT", parentId: 10 }),
      channel({ id: 1, name: "news", type: "TEXT", position: 0 }),
      games,
      channel({ id: 4, name: "music", type: "VOICE", position: 2 }),
    ]);

    expect(ladderOf(groups)).toEqual([
      "free:news",
      "cat:Games [general,lobby]",
      "free:music",
    ]);
  });

  it("a free channel can sit BETWEEN categories (the 2026-11-24 round)", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 1, name: "catA", type: "CATEGORY", position: 0 }),
      channel({ id: 2, name: "in-the-middle", type: "TEXT", position: 1 }),
      channel({ id: 3, name: "catB", type: "CATEGORY", position: 2 }),
      channel({ id: 4, name: "under-B", type: "TEXT", parentId: 3 }),
    ]);
    expect(ladderOf(groups)).toEqual([
      "cat:catA [,]",
      "free:in-the-middle",
      "cat:catB [under-B,]",
    ]);
  });

  it("sorts everything by (position, id), not by input order", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 7, name: "z-late", type: "TEXT", position: 9 }),
      channel({ id: 6, name: "a-early", type: "TEXT", position: 1 }),
      channel({ id: 5, name: "catB", type: "CATEGORY", position: 2 }),
      channel({ id: 4, name: "catA", type: "CATEGORY", position: 1 }),
    ]);
    expect(groups.topLevel.map((node) => node.kind === "free" ? node.channel.name : node.category.name))
      .toEqual(["catA", "a-early", "catB", "z-late"]);
  });

  it("falls back a child of an INVISIBLE category to a free node", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 1, name: "hidden-child", type: "TEXT", parentId: 999 }),
    ]);
    expect(ladderOf(groups)).toEqual(["free:hidden-child"]);
  });
});

describe("flattenGroupsForPersist", () => {
  it("walks the ladder in order: free channels where they stand, each category row followed by its children", () => {
    const groups = groupChannelsByCategory([
      channel({ id: 1, name: "news", type: "TEXT", position: 0 }),
      channel({ id: 3, name: "Games", type: "CATEGORY", position: 1 }),
      channel({ id: 5, name: "general", type: "TEXT", parentId: 3 }),
      channel({ id: 4, name: "lounge", type: "VOICE", parentId: 3 }),
      channel({ id: 2, name: "between", type: "VOICE", position: 2 }),
    ]);
    expect(flattenGroupsForPersist(groups)).toEqual([
      { id: 1, parentId: null },
      { id: 3, parentId: null },
      { id: 5, parentId: 3 },
      { id: 4, parentId: 3 },
      { id: 2, parentId: null },
    ]);
  });

  it("round-trips: flatten → dense renumber → the same ladder structure", () => {
    const original = groupChannelsByCategory([
      channel({ id: 1, name: "news", type: "TEXT", position: 0 }),
      channel({ id: 2, name: "Games", type: "CATEGORY", position: 1 }),
      channel({ id: 3, name: "general", type: "TEXT", parentId: 2 }),
      channel({ id: 4, name: "lobby", type: "VOICE", parentId: 2 }),
      channel({ id: 5, name: "music", type: "VOICE", position: 2 }),
      channel({ id: 6, name: "After", type: "CATEGORY", position: 3 }),
    ]);
    const flattened = flattenGroupsForPersist(original);
    const byId = new Map(original.topLevel.flatMap((node): Channel[] => node.kind === "free"
      ? [node.channel]
      : [node.category, ...node.textChannels, ...node.voiceChannels])
      .map((channelEntry) => [channelEntry.id, channelEntry]));
    // The server renumbers positions by list index — simulate that and regroup.
    const renumbered = flattened.map((entry, index) =>
      ({ ...byId.get(entry.id)!, position: index, parentId: entry.parentId }));
    expect(ladderOf(groupChannelsByCategory(renumbered))).toEqual(ladderOf(original));
  });
});
