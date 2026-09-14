import { describe, expect, it } from "vitest";
import { toastPreview, toastPreviewSegments } from "../src/domain/logic/toast-preview";

describe("toastPreview", () => {
  it("collapses whitespace but KEEPS mention names (user decision: who was pinged stays visible)", () => {
    expect(toastPreview("hey @alice   check   this @bob")).toBe("hey @alice check this @bob");
    expect(toastPreview("  lots   of\n\nspaces\ttoo ")).toBe("lots of spaces too");
  });

  it("truncates to 80 chars with an ellipsis", () => {
    const long = "a".repeat(120);
    expect(toastPreview(long)).toBe(`${"a".repeat(80)}…`);
    expect(toastPreview("a".repeat(80))).toBe("a".repeat(80)); // exactly at the cap — untouched
  });

  it("empty and null content give an empty preview", () => {
    expect(toastPreview(null)).toBe("");
    expect(toastPreview("")).toBe("");
    expect(toastPreview("   ")).toBe("");
  });
});

describe("toastPreviewSegments", () => {
  // The recipient: user id 7 holding role 11.
  const SELF = { userId: 7, roleIds: [11], suppressEveryoneHere: false };

  it("tints ONLY pings that target the recipient; others' mentions stay grey", () => {
    const content = "hey @alice and @bob plus @everyone";
    // @alice = USER me (id 7) → lit; @bob = USER someone else → grey; @everyone → lit
    const segments = toastPreviewSegments(content, [
      { type: "USER", id: 7, start: 4, end: 10 },
      { type: "USER", id: 99, start: 15, end: 19 },
      { type: "EVERYONE", id: null, start: 25, end: 34 },
    ], SELF);
    expect(segments).toEqual([
      { text: "hey ", mention: false },
      { text: "@alice", mention: true },
      { text: " and ", mention: false },
      { text: "@bob", mention: false },
      { text: " plus ", mention: false },
      { text: "@everyone", mention: true },
    ]);
  });

  it("an @role I hold lights up; a role I don't hold and suppressed @everyone stay grey", () => {
    const content = "@mods @guests @here";
    const segments = toastPreviewSegments(content, [
      { type: "ROLE", id: 11, start: 0, end: 5 },
      { type: "ROLE", id: 77, start: 6, end: 13 },
      { type: "HERE", id: null, start: 14, end: 19 },
    ], { ...SELF, suppressEveryoneHere: true });
    expect(segments).toEqual([
      { text: "@mods", mention: true },
      { text: "@guests", mention: false }, // whitespace-only gaps are dropped by design
      { text: "@here", mention: false },
    ]);
  });

  it("without identity nothing tints (roster not resolved — better grey than a false ping)", () => {
    const segments = toastPreviewSegments("@you", [{ type: "USER", id: 7, start: 0, end: 4 }]);
    expect(segments).toEqual([{ text: "@you", mention: false }]);
  });

  it("skips malformed and overlapping ranges (chat segmenter rules)", () => {
    const content = "@aa @bb";
    const segments = toastPreviewSegments(content, [
      { type: "USER", id: 7, start: -1, end: 3 }, // malformed
      { type: "USER", id: 7, start: 0, end: 3 }, // @aa
      { type: "USER", id: 7, start: 1, end: 6 }, // overlaps @aa — dropped
    ], SELF);
    expect(segments).toEqual([
      { text: "@aa", mention: true },
      { text: " @bb", mention: false },
    ]);
  });

  it("shares the 80-char budget across segments; the ellipsis is its own plain segment", () => {
    const content = `${"x".repeat(50)} @${"b".repeat(60)}`;
    const segments = toastPreviewSegments(content, [
      { type: "USER", id: 7, start: 50, end: 111 },
    ], SELF);
    expect(segments).toEqual([
      { text: "x".repeat(50), mention: false },
      { text: ` @${"b".repeat(28)}`, mention: true }, // the cut span keeps its flag
      { text: "…", mention: false },
    ]);
  });

  it("empty content gives no segments", () => {
    expect(toastPreviewSegments(null, [])).toEqual([]);
    expect(toastPreviewSegments("   ", [{ type: "USER", id: 7, start: 0, end: 1 }], SELF)).toEqual([]);
  });
});
