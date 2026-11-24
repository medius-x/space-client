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

/** The ladder as readable lines: "free:name" / "cat:name [text…, voice…]". */
function ladderOf(groups: ReturnType<typeof modelOf>): string[] {
  return groups.topLevel.map((node) => node.kind === "free"
    ? `free:${node.channel.name}`
    : `cat:${node.category.name} [${node.textChannels.map((entry) => entry.name)},${node.voiceChannels.map((entry) => entry.name)}]`);
}

const GENERAL = channel({ id: 1, name: "general", type: "TEXT" });
const RANDOM = channel({ id: 2, name: "random", type: "TEXT" });
const NEWS = channel({ id: 3, name: "news", type: "TEXT" });
const LOBBY = channel({ id: 4, name: "lobby", type: "VOICE" });
const GAMES = channel({ id: 10, name: "Games", type: "CATEGORY" });
const WORK = channel({ id: 11, name: "Work", type: "CATEGORY" });
const IN_GAMES_TEXT = channel({ id: 5, name: "g-text", type: "TEXT", parentId: 10 });

describe("applyChannelDrop — channels", () => {
  it("reorders within the top-level ladder", () => {
    const groups = modelOf(GENERAL, RANDOM, NEWS);
    const next = applyChannelDrop(groups, { kind: "channel", channel: NEWS },
      { list: "top", beforeId: GENERAL.id });
    expect(next !== null && ladderOf(next)).toEqual(["free:news", "free:general", "free:random"]);
  });

  it("moves a channel into a category", () => {
    const groups = modelOf(GENERAL, GAMES);
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "cat-text", categoryId: GAMES.id, beforeId: null });
    expect(next !== null && ladderOf(next)).toEqual(["cat:Games [general,]"]);
  });

  it("moves a channel out of a category to the ladder", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT);
    const next = applyChannelDrop(groups, { kind: "channel", channel: IN_GAMES_TEXT },
      { list: "top", beforeId: null });
    expect(next !== null && ladderOf(next)).toEqual(["cat:Games [,]", "free:g-text"]);
  });

  it("moves a channel BETWEEN categories (the 2026-11-24 round)", () => {
    const groups = modelOf(GAMES, WORK, IN_GAMES_TEXT);
    const next = applyChannelDrop(groups, { kind: "channel", channel: IN_GAMES_TEXT },
      { list: "top", beforeId: WORK.id });
    expect(next !== null && ladderOf(next)).toEqual([
      "cat:Games [,]",
      "free:g-text",
      "cat:Work [,]",
    ]);
  });

  it("moves a channel between categories", () => {
    const inGames = channel({ id: 5, name: "g-text", type: "TEXT", parentId: 10 });
    const groups = modelOf(GAMES, WORK, inGames);
    const next = applyChannelDrop(groups, { kind: "channel", channel: inGames },
      { list: "cat-text", categoryId: WORK.id, beforeId: null });
    expect(next !== null && ladderOf(next)).toEqual([
      "cat:Games [,]",
      "cat:Work [g-text,]",
    ]);
  });

  it("normalizes a text channel dropped over a voice row into that block's text list", () => {
    const inGamesLobby = channel({ id: 6, name: "g-lobby", type: "VOICE", parentId: 10 });
    const groups = modelOf(GENERAL, NEWS, GAMES, IN_GAMES_TEXT, inGamesLobby);
    // The voice row is the drop row; GENERAL (text) lands in that category's
    // TEXT list at the END (after g-text, which originally preceded it).
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "cat-voice", categoryId: GAMES.id, beforeId: inGamesLobby.id });
    expect(next !== null && ladderOf(next)).toEqual([
      "free:news",
      "cat:Games [g-text,general,g-lobby]",
    ]);
  });

  it("keeps voice channels out of text lists (cat-voice normalization)", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT, LOBBY);
    const next = applyChannelDrop(groups, { kind: "channel", channel: LOBBY },
      { list: "cat-text", categoryId: GAMES.id, beforeId: IN_GAMES_TEXT.id });
    // Dropped over a text row — the voice channel lands in the SAME category's voice list.
    expect(next !== null && ladderOf(next)).toEqual(["cat:Games [g-text,lobby]"]);
  });

  it("returns null for a no-op drop", () => {
    const groups = modelOf(GENERAL, RANDOM);
    expect(applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "top", beforeId: RANDOM.id })).toBeNull(); // already before RANDOM
    expect(applyChannelDrop(groups, { kind: "channel", channel: RANDOM },
      { list: "top", beforeId: null })).toBeNull(); // already last
  });

  it("drops a channel on a COLLAPSED category header INTO that category (the hit-test translation)", () => {
    const groups = modelOf(GENERAL, GAMES);
    // The hit-test turns a COLLAPSED header row for a CHANNEL drag into a
    // cat-* append; an EXPANDED header positions on the ladder instead.
    const next = applyChannelDrop(groups, { kind: "channel", channel: GENERAL },
      { list: "cat-text", categoryId: GAMES.id, beforeId: null });
    expect(next !== null && ladderOf(next)).toEqual(["cat:Games [general,]"]);
  });

  it("returns null when the subject is not in the model", () => {
    const groups = modelOf(GENERAL);
    const stranger = channel({ id: 99, name: "stranger", type: "TEXT" });
    expect(applyChannelDrop(groups, { kind: "channel", channel: stranger },
      { list: "top", beforeId: null })).toBeNull();
  });
});

describe("applyChannelDrop — categories", () => {
  it("reorders category blocks along the ladder", () => {
    const groups = modelOf(GAMES, WORK);
    const next = applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "top", beforeId: GAMES.id });
    expect(next !== null && ladderOf(next)).toEqual(["cat:Work [,]", "cat:Games [,]"]);
  });

  it("moves a category BETWEEN free channels", () => {
    const groups = modelOf(GENERAL, RANDOM, GAMES, WORK);
    const next = applyChannelDrop(groups, { kind: "category", category: GAMES },
      { list: "top", beforeId: RANDOM.id });
    expect(next !== null && ladderOf(next)).toEqual([
      "free:general",
      "cat:Games [,]",
      "free:random",
      "cat:Work [,]",
    ]);
  });

  it("carries the children along", () => {
    const groups = modelOf(GAMES, IN_GAMES_TEXT, WORK);
    const next = applyChannelDrop(groups, { kind: "category", category: GAMES },
      { list: "top", beforeId: null }); // append Games after Work
    expect(next !== null && ladderOf(next)).toEqual([
      "cat:Work [,]",
      "cat:Games [g-text,]",
    ]);
  });

  it("refuses a category dropped into a channel list", () => {
    const groups = modelOf(GAMES, WORK);
    expect(applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "cat-text", categoryId: GAMES.id, beforeId: null } as DropTarget)).toBeNull();
  });

  it("returns null for a no-op category drop", () => {
    const groups = modelOf(GAMES, WORK);
    expect(applyChannelDrop(groups, { kind: "category", category: WORK },
      { list: "top", beforeId: null })).toBeNull();
  });
});
