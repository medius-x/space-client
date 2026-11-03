import { describe, expect, it } from "vitest";
import {
  MAX_SPELL_WORDS,
  sanitizeSpellWords,
  withAddedSpellWord,
  wordRangeAt,
} from "../src/domain/logic/spell-word";

describe("wordRangeAt", () => {
  it("returns the word the caret sits inside", () => {
    expect(wordRangeAt("hello wrld", 7)).toEqual({ start: 6, end: 10 });
  });

  it("a caret right AFTER a word still names that word", () => {
    expect(wordRangeAt("превет мир", 6)).toEqual({ start: 0, end: 6 });
  });

  it("a caret on a leading boundary belongs to the word it touches", () => {
    expect(wordRangeAt("a bb", 2)).toEqual({ start: 2, end: 4 });
  });

  it("inner apostrophes and hyphens stay part of the word", () => {
    expect(wordRangeAt("don't кое-кто", 3)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt("don't кое-кто", 8)).toEqual({ start: 6, end: 13 });
  });

  it("whitespace and punctuation yield null", () => {
    // A caret on a space still names the word it LEFT (a right click there
    // lands right after a word) — so "a  b" caret 1 is "a", not null. Null is
    // for spots touching NO word at all: between punctuation, or a caret
    // past a trailing space.
    expect(wordRangeAt("a  b", 1)).toEqual({ start: 0, end: 1 });
    expect(wordRangeAt("a, b", 2)).toBeNull();
    expect(wordRangeAt("word ", 99)).toBeNull();
    expect(wordRangeAt("", 0)).toBeNull();
  });

  it("clamps out-of-range carets instead of throwing", () => {
    expect(wordRangeAt("word", 99)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt("word", -5)).toEqual({ start: 0, end: 4 });
  });

  it("a caret between two words separated by one space names the LEFT word", () => {
    // position 1 is inside "a"? no — "a b": caret 1 is the space-ish boundary
    // after "a": falls back to the previous char, which is a word char.
    expect(wordRangeAt("a b", 1)).toEqual({ start: 0, end: 1 });
  });
});

describe("sanitizeSpellWords", () => {
  it("keeps trimmed strings and drops junk", () => {
    expect(sanitizeSpellWords(["Kyiv", " kyiv ", 42, null, "", "   "])).toEqual(["Kyiv", "kyiv"]);
  });

  it("drops duplicates after trimming", () => {
    expect(sanitizeSpellWords(["hi", " hi", "hi "])).toEqual(["hi"]);
  });

  it("caps at the limit", () => {
    const many = Array.from({ length: MAX_SPELL_WORDS + 50 }, (_, index) => `w${index}`);
    expect(sanitizeSpellWords(many)).toHaveLength(MAX_SPELL_WORDS);
  });

  it("non-array input yields an empty list", () => {
    expect(sanitizeSpellWords(null)).toEqual([]);
    expect(sanitizeSpellWords("word")).toEqual([]);
    expect(sanitizeSpellWords(undefined)).toEqual([]);
  });
});

describe("withAddedSpellWord", () => {
  it("appends a fresh word", () => {
    expect(withAddedSpellWord(["a"], "b")).toEqual(["a", "b"]);
  });

  it("trims before comparing and adding", () => {
    expect(withAddedSpellWord(["a"], "  b  ")).toEqual(["a", "b"]);
  });

  it("a duplicate is a content no-op (but a fresh reference)", () => {
    const words = ["a", "b"];
    const next = withAddedSpellWord(words, "a");
    expect(next).toEqual(["a", "b"]);
    expect(next).not.toBe(words);
  });

  it("junk words change nothing", () => {
    expect(withAddedSpellWord(["a"], "   ")).toEqual(["a"]);
  });

  it("evicts the OLDEST entry at the cap", () => {
    const words = Array.from({ length: MAX_SPELL_WORDS }, (_, index) => `w${index}`);
    const next = withAddedSpellWord(words, "new");
    expect(next).toHaveLength(MAX_SPELL_WORDS);
    expect(next[0]).toBe("w1"); // w0 evicted
    expect(next[next.length - 1]).toBe("new");
  });
});
