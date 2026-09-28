import { describe, expect, it } from "vitest";
import {
  clampJumboEmojiSize,
  emojiNameFromFileName,
  filterEmojis,
  isEmojiOnlyMessage,
  jumboEmojiEstimateExtra,
} from "../src/domain/logic/emoji-picker";
import type { CustomEmoji } from "../src/types";
import type { MessageSegment } from "../src/domain/logic/mention-segmenter";

function emojiOf(id: number, name: string): CustomEmoji {
  return { id, name, url: null, key: `custom-emojis/u/${name}.png`, uploadedBy: 1 };
}

describe("emojiNameFromFileName (the upload form's default name)", () => {
  it("lowercases and strips the extension", () => {
    expect(emojiNameFromFileName("HappyCat.PNG")).toBe("happycat");
  });

  it("collapses anything outside [a-z0-9_-] into dashes and trims them", () => {
    expect(emojiNameFromFileName("my cool cat!! (v2).gif")).toBe("my-cool-cat-v2");
  });

  it("clamps to the 32-char server limit", () => {
    expect(emojiNameFromFileName("a".repeat(50) + ".png")).toHaveLength(32);
  });

  it("empty when nothing usable remains", () => {
    expect(emojiNameFromFileName("!!!.png")).toBe("");
  });
});

describe("filterEmojis (the picker search)", () => {
  const catalog = [emojiOf(1, "cat"), emojiOf(2, "catgirl"), emojiOf(3, "doge")];

  it("a blank query shows everything", () => {
    expect(filterEmojis(catalog, "  ")).toHaveLength(3);
  });

  it("a case-insensitive substring match", () => {
    expect(filterEmojis(catalog, "CAT").map((emoji) => emoji.name)).toEqual(["cat", "catgirl"]);
  });

  it("no match yields an empty list (the 'Nothing matches' state)", () => {
    expect(filterEmojis(catalog, "zebra")).toEqual([]);
  });
});

describe("isEmojiOnlyMessage (the jumbo render rule)", () => {
  const emojiSegment = (name: string): MessageSegment => ({ kind: "emoji", text: `:${name}:`, name });
  const textSegment = (text: string): MessageSegment => ({ kind: "text", text });

  it("a lone emoji token renders large", () => {
    expect(isEmojiOnlyMessage([emojiSegment("cat")])).toBe(true);
  });

  it("whitespace gaps between/around tokens do not break the rule", () => {
    expect(isEmojiOnlyMessage([textSegment(" "), emojiSegment("cat"), textSegment("  "), emojiSegment("doge")])).toBe(true);
  });

  it("any real text demotes the row to inline size", () => {
    expect(isEmojiOnlyMessage([textSegment("hi "), emojiSegment("cat")])).toBe(false);
  });

  it("links and mentions also demote", () => {
    expect(isEmojiOnlyMessage([{ kind: "link", text: "http://x", url: "http://x" }, emojiSegment("cat")])).toBe(false);
  });

  it("an empty segment list is never jumbo", () => {
    expect(isEmojiOnlyMessage([])).toBe(false);
  });
});

describe("clampJumboEmojiSize (the Appearance slider bounds)", () => {
  it("keeps in-range values (rounded)", () => {
    expect(clampJumboEmojiSize(48)).toBe(48);
    expect(clampJumboEmojiSize(96)).toBe(96);
    expect(clampJumboEmojiSize(18)).toBe(18);
  });

  it("clamps out-of-range values to the bounds", () => {
    expect(clampJumboEmojiSize(4)).toBe(18);
    expect(clampJumboEmojiSize(500)).toBe(96);
  });

  it("garbage falls back to the default", () => {
    expect(clampJumboEmojiSize(undefined)).toBe(48);
    expect(clampJumboEmojiSize(Number.NaN)).toBe(48);
  });
});

describe("jumboEmojiEstimateExtra (the virtual-list prepayment)", () => {
  it("emoji-only content pays only above the proven 48px", () => {
    expect(jumboEmojiEstimateExtra(":cat:", 48)).toBe(0);
    expect(jumboEmojiEstimateExtra(":cat:", 18)).toBe(0);
    expect(jumboEmojiEstimateExtra(" :cat: :doge: ", 96)).toBe(48);
  });

  it("any real content pays nothing", () => {
    expect(jumboEmojiEstimateExtra("hi :cat:", 96)).toBe(0);
    expect(jumboEmojiEstimateExtra("plain text", 96)).toBe(0);
    expect(jumboEmojiEstimateExtra(null, 96)).toBe(0);
  });

  it("a token the catalog lacks still pre-pays (slight over-estimate until measured)", () => {
    expect(jumboEmojiEstimateExtra(":ghost:", 96)).toBe(48);
  });
});
