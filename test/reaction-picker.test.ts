import { describe, expect, it } from "vitest";
import {
  customEmojiNameOfReactionSlug,
  filterBuiltInReactions,
  pushRecentExpression,
  reactionPickerPosition,
  REACTION_PICKER_WIDTH_PX,
  RECENT_EXPRESSIONS_CAP,
  resolveRecentExpressionEntries,
  sanitizeRecentExpressions,
  type BuiltInReaction,
} from "../src/domain/logic/reaction-picker";
import type { CustomEmoji } from "../src/types";

const CATALOG: readonly BuiltInReaction[] = [
  { slug: "thumbsup", glyph: "👍" },
  { slug: "heart", glyph: "❤️" },
  { slug: "facepalm", glyph: "🤦" },
];

describe("customEmojiNameOfReactionSlug", () => {
  it("unwraps a well-formed :name: token", () => {
    expect(customEmojiNameOfReactionSlug(":cat:")).toBe("cat");
    expect(customEmojiNameOfReactionSlug(":a-b_c9:")).toBe("a-b_c9");
    // the discriminator is structural: a colon-wrapped built-in name is a CUSTOM emoji
    expect(customEmojiNameOfReactionSlug(":heart:")).toBe("heart");
  });

  it("returns null for bare built-in slugs", () => {
    expect(customEmojiNameOfReactionSlug("heart")).toBeNull();
    expect(customEmojiNameOfReactionSlug("thumbsup")).toBeNull();
  });

  it("returns null for anything outside the grammar", () => {
    expect(customEmojiNameOfReactionSlug("::")).toBeNull(); // empty name
    expect(customEmojiNameOfReactionSlug(":UPPER:")).toBeNull(); // case
    expect(customEmojiNameOfReactionSlug(":cat")).toBeNull(); // unclosed
    expect(customEmojiNameOfReactionSlug("cat:")).toBeNull(); // unopened
    expect(customEmojiNameOfReactionSlug(`:${"x".repeat(33)}:`)).toBeNull(); // too long
    expect(customEmojiNameOfReactionSlug("::cat::")).toBeNull(); // extra colons
  });

  it("accepts the full 32-char name length", () => {
    expect(customEmojiNameOfReactionSlug(`:${"x".repeat(32)}:`)).toBe("x".repeat(32));
  });
});

describe("filterBuiltInReactions", () => {
  it("an empty/blank query shows everything", () => {
    expect(filterBuiltInReactions(CATALOG, "")).toEqual([...CATALOG]);
    expect(filterBuiltInReactions(CATALOG, "   ")).toEqual([...CATALOG]);
  });

  it("matches by case-insensitive slug substring", () => {
    expect(filterBuiltInReactions(CATALOG, "thumb")).toEqual([{ slug: "thumbsup", glyph: "👍" }]);
    expect(filterBuiltInReactions(CATALOG, "HEART")).toEqual([{ slug: "heart", glyph: "❤️" }]);
  });

  it("a query that misses everything empties the section", () => {
    expect(filterBuiltInReactions(CATALOG, "elephant")).toEqual([]);
  });
});

describe("reactionPickerPosition", () => {
  it("opens below the anchor when the viewport has room", () => {
    expect(reactionPickerPosition(100, 200, 1280, 800)).toEqual({ left: 100, top: 204 });
  });

  it("flips up when the space below is short", () => {
    // 780 + 424 > 800 - 8 → flip: the popup's bottom edge sits just above the anchor
    expect(reactionPickerPosition(100, 780, 1280, 800)).toEqual({ left: 100, top: 780 - 424 });
  });

  it("clamps into the viewport at the right edge", () => {
    expect(reactionPickerPosition(1270, 200, 1280, 800).left).toBe(1280 - REACTION_PICKER_WIDTH_PX - 8);
  });

  it("vertically clamps when the popup fits neither below nor above", () => {
    // a 500px window: 300 + 424 > 492 and 300 - 424 < 8 → clamp to the lowest top
    expect(reactionPickerPosition(100, 300, 1280, 500).top).toBe(500 - 424 - 8);
    // a window shorter than the popup itself: the clamp floor is the top margin
    expect(reactionPickerPosition(100, 300, 1280, 400).top).toBe(8);
  });
});

describe("pushRecentExpression", () => {
  it("moves a fresh use to the front, newest first", () => {
    expect(pushRecentExpression(["heart"], ":cat:")).toEqual([":cat:", "heart"]);
    // re-using an OLD entry revives it at the front, not duplicated
    expect(pushRecentExpression([":cat:", "heart", "smile"], "heart")).toEqual(["heart", ":cat:", "smile"]);
  });

  it("caps the MRU at the Latest-row size", () => {
    const filled = ["a", ":b:", "c", ":d:", "e", ":f:", "g", ":h:"]; // 8 entries
    const pushed = pushRecentExpression(filled, "thumbsup");
    expect(pushed).toHaveLength(RECENT_EXPRESSIONS_CAP);
    expect(pushed[0]).toBe("thumbsup");
    expect(pushed).not.toContain("h"); // the oldest fell off
  });
});

describe("sanitizeRecentExpressions", () => {
  it("keeps valid slugs, drops junk and unknown names", () => {
    expect(sanitizeRecentExpressions(["heart", ":cat:", "elephant", 42, null])).toEqual(["heart", ":cat:"]);
  });

  it("dedups and caps", () => {
    expect(sanitizeRecentExpressions(["smile", "smile", ":cat:"])).toEqual(["smile", ":cat:"]);
    const nine = Array.from({ length: 9 }, (unused, index) => `e${index}`);
    // none are valid built-ins/customs → empty; use valid ":name:" tokens instead
    const nineTokens = nine.map((name) => `:${name}:`);
    expect(sanitizeRecentExpressions(nineTokens)).toHaveLength(RECENT_EXPRESSIONS_CAP);
  });

  it("non-array garbage yields an empty list", () => {
    expect(sanitizeRecentExpressions(undefined)).toEqual([]);
    expect(sanitizeRecentExpressions("heart")).toEqual([]);
  });
});

describe("resolveRecentExpressionEntries", () => {
  const cat: CustomEmoji = { id: 1, name: "cat", url: "http://x/cat.png", key: "custom-emojis/k/cat.png", uploadedBy: null };
  const dog: CustomEmoji = { id: 2, name: "dog", url: "http://x/dog.png", key: "custom-emojis/k/dog.png", uploadedBy: null };
  const byName = new Map([["cat", cat], ["dog", dog]]);

  it("resolves built-ins to glyphs and customs to catalog rows, order preserved", () => {
    const entries = resolveRecentExpressionEntries([":cat:", "heart"], byName);
    expect(entries).toEqual([
      { slug: ":cat:", glyph: null, emoji: cat },
      { slug: "heart", glyph: "❤️", emoji: null },
    ]);
  });

  it("drops dead customs (deleted from the catalog) and unknown built-ins", () => {
    expect(resolveRecentExpressionEntries([":ghost:", "elephant", "smile"], byName)).toEqual([
      { slug: "smile", glyph: "😄", emoji: null },
    ]);
  });

  it("a query keeps only matching entries, either kind", () => {
    expect(resolveRecentExpressionEntries([":cat:", ":dog:", "heart"], byName, "do")).toEqual([
      { slug: ":dog:", glyph: null, emoji: dog },
    ]);
    // a built-in matches by slug, a custom by name — one query covers both
    expect(resolveRecentExpressionEntries([":cat:", "cry"], byName, "c")).toEqual([
      { slug: ":cat:", glyph: null, emoji: cat },
      { slug: "cry", glyph: "😢", emoji: null },
    ]);
  });
});
