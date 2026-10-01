import { describe, expect, it } from "vitest";
import { groupChannelsByCategory } from "../src/domain/logic/channel-groups";
import { applyChannelDrop, type DropTarget } from "../src/domain/logic/channel-drag";
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

function modelOf(...channels: Channel[]) {
  return groupChannelsByCategory(channels);
}

const GENERAL = channel({ id: 1, name: "general", type: "TEXT" });
const RANDOM = channel({ id: 2, name: "random", type: "TEXT" });
const NEWS = channel({ id: 3, name: "news", type: "TEXT" });
const LOBBY = channel({ id: 4, name: "lobby", type: "VOICE" });
const GAMES = channel({ id: 10, name: "Games", type: "CATEGORY" });
const WORK = channel({ id: 11, name: "Work", type: "CATEGORY" });
const IN_GAMES_TEXT = channel({ id: 5, name: "g-text", type: "TEXT", parentId: 10 });

describe("applyChannelDrop — channels", () => {
  it("reorders within the uncategorized text list", () => {
    const groups = modelOf(GENERAL, RANDOM, NEWS);
    const next = applyChannelDrop(groups, { kind: "channel", channel: NEWS },
      { list: "uncat-text", beforeId: GENERAL.id });
    expect(next!.uncategorizedText.map((entry) => entry.name)).toEqual(["news", "general", "random"]);
  });

  it("moves a channel into a category", () => {
    const groups = modelOf(GENERAL, GAMES);
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "cat-text", categoryId: GAMES.id, beforeId: null });
    expect(next!.uncategorizedText).toHaveLength(0);
    expect(next!.categories[0]!.textChannels.map((entry) => entry.name)).toEqual(["general"]);
  });

  it("moves a channel out of a category to top level", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT);
    const next = applyChannelDrop(groups, { kind: "channel", channel: IN_GAMES_TEXT },
      { list: "uncat-text", beforeId: null });
    expect(next!.uncategorizedText.map((entry) => entry.name)).toEqual(["g-text"]);
    expect(next!.categories[0]!.textChannels).toHaveLength(0);
  });

  it("moves a channel between categories", () => {
    const inGames = channel({ id: 5, name: "g-text", type: "TEXT", parentId: 10 });
    const groups = modelOf(GAMES, WORK, inGames);
    const next = applyChannelDrop(groups, { kind: "channel", channel: inGames },
      { list: "cat-text", categoryId: WORK.id, beforeId: null });
    expect(next!.categories[0]!.textChannels).toHaveLength(0);
    expect(next!.categories[1]!.textChannels.map((entry) => entry.name)).toEqual(["g-text"]);
  });

  it("normalizes a text channel dropped over a voice row into that block's text list", () => {
    const groups = modelOf(GENERAL, NEWS, GAMES, IN_GAMES_TEXT, LOBBY);
    // LOBBY (uncat voice) is the drop row; GENERAL lands in uncat-TEXT at the END
    // (after NEWS, which originally followed it).
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "uncat-voice", beforeId: LOBBY.id });
    expect(next!.uncategorizedText.map((entry) => entry.name)).toEqual(["news", "general"]);
    expect(next!.uncategorizedVoice.map((entry) => entry.name)).toEqual(["lobby"]);
  });

  it("keeps voice channels out of text lists (cat-voice normalization)", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT, LOBBY);
    const next = applyChannelDrop(groups, { kind: "channel", channel: LOBBY },
      { list: "cat-text", categoryId: GAMES.id, beforeId: IN_GAMES_TEXT.id });
    // Dropped over a text row — the voice channel lands in the SAME category's voice list.
    expect(next!.categories[0]!.voiceChannels.map((entry) => entry.name)).toEqual(["lobby"]);
    expect(next!.categories[0]!.textChannels.map((entry) => entry.name)).toEqual(["g-text"]);
  });

  it("returns null for a no-op drop", () => {
    const groups = modelOf(GENERAL, RANDOM);
    expect(applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "uncat-text", beforeId: RANDOM.id })).toBeNull(); // already before RANDOM
    expect(applyChannelDrop(groups, { kind: "channel", channel: RANDOM },
      { list: "uncat-text", beforeId: null })).toBeNull(); // already last
  });

  it("drops a channel ON a category header INTO that category (Discord)", () => {
    const groups = modelOf(GENERAL, GAMES);
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "categories", categoryId: GAMES.id, beforeId: null });
    expect(next!.uncategorizedText).toHaveLength(0);
    expect(next!.categories[0]!.textChannels.map((entry) => entry.name)).toEqual(["general"]);
  });

  it("returns null when the subject is not in the model", () => {
    const groups = modelOf(GENERAL);
    const stranger = channel({ id: 99, name: "stranger", type: "TEXT" });
    expect(applyChannelDrop(groups, { kind: "channel", channel: stranger },
      { list: "uncat-text", beforeId: null })).toBeNull();
  });
});

describe("applyChannelDrop — categories", () => {
  it("reorders category blocks", () => {
    const groups = modelOf(GAMES, WORK);
    const next = applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "categories", beforeId: GAMES.id });
    expect(next!.categories.map((group) => group.category.name)).toEqual(["Work", "Games"]);
  });

  it("carries the children along", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT, WORK);
    const next = applyChannelDrop(groups, { kind: "category", category: GAMES },
      { list: "categories", beforeId: null }); // append Games after Work
    expect(next!.categories.map((group) => group.category.name)).toEqual(["Work", "Games"]);
    expect(next!.categories[1]!.textChannels.map((entry) => entry.name)).toEqual(["g-text"]);
  });

  it("refuses a category dropped into a channel list", () => {
    const groups = modelOf(GAMES, WORK);
    expect(applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "uncat-text", beforeId: null } as DropTarget)).toBeNull();
  });

  it("returns null for a no-op category drop", () => {
    const groups = modelOf(GAMES, WORK);
    expect(applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "categories", beforeId: null })).toBeNull();
  });
});
