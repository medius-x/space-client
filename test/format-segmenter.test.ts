import { describe, expect, it } from "vitest";
import { segmentMessageContent, type FormatKind, type MessageSegment } from "../src/domain/logic/mention-segmenter";

const NO_EMOJIS = undefined;

function formatted(format: FormatKind, ...children: MessageSegment[]): MessageSegment {
  return { kind: "formatted", format, children };
}

describe("segmentMessageContent — formatting pass", () => {
  it("each basic marker wraps its content", () => {
    expect(segmentMessageContent("**bold**", [], NO_EMOJIS)).toEqual([
      formatted("bold", { kind: "text", text: "bold" }),
    ]);
    expect(segmentMessageContent("*italic*", [], NO_EMOJIS)).toEqual([
      formatted("italic", { kind: "text", text: "italic" }),
    ]);
    expect(segmentMessageContent("__underline__", [], NO_EMOJIS)).toEqual([
      formatted("underline", { kind: "text", text: "underline" }),
    ]);
    expect(segmentMessageContent("~~strike~~", [], NO_EMOJIS)).toEqual([
      formatted("strike", { kind: "text", text: "strike" }),
    ]);
    expect(segmentMessageContent("||spoiler||", [], NO_EMOJIS)).toEqual([
      formatted("spoiler", { kind: "text", text: "spoiler" }),
    ]);
  });

  it("text before and after a formatted span stays plain", () => {
    expect(segmentMessageContent("a **b** c", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "a " },
      formatted("bold", { kind: "text", text: "b" }),
      { kind: "text", text: " c" },
    ]);
  });

  it("two formatted spans on one line each resolve", () => {
    expect(segmentMessageContent("**a** and *b*", [], NO_EMOJIS)).toEqual([
      formatted("bold", { kind: "text", text: "a" }),
      { kind: "text", text: " and " },
      formatted("italic", { kind: "text", text: "b" }),
    ]);
  });

  it("markers nest — italic inside bold", () => {
    expect(segmentMessageContent("**bold *and* italic**", [], NO_EMOJIS)).toEqual([
      formatted("bold",
        { kind: "text", text: "bold " },
        formatted("italic", { kind: "text", text: "and" }),
        { kind: "text", text: " italic" }),
    ]);
  });

  it("***combo*** is bold wrapping an italic", () => {
    expect(segmentMessageContent("***x***", [], NO_EMOJIS)).toEqual([
      formatted("bold", formatted("italic", { kind: "text", text: "x" })),
    ]);
  });

  it("a single star closes on the LAST star — the inner ** pair stays bold", () => {
    expect(segmentMessageContent("*a **b** c*", [], NO_EMOJIS)).toEqual([
      formatted("italic",
        { kind: "text", text: "a " },
        formatted("bold", { kind: "text", text: "b" }),
        { kind: "text", text: " c" }),
    ]);
  });

  it("an unclosed marker stays plain text", () => {
    expect(segmentMessageContent("**bold", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "**bold" },
    ]);
    expect(segmentMessageContent("just a star *", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "just a star *" },
    ]);
  });

  it("an empty pair stays plain text", () => {
    expect(segmentMessageContent("****", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "****" },
    ]);
    expect(segmentMessageContent("a||  ||b", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "a||  ||b" },
    ]);
  });

  it("content with an edge space does not match — math stays math", () => {
    expect(segmentMessageContent("2 * 3 * 4", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "2 * 3 * 4" },
    ]);
    expect(segmentMessageContent("** trailing space**", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "** trailing space**" },
    ]);
  });

  it("inline code is terminal — markers and emoji tokens inside stay literal", () => {
    expect(segmentMessageContent("run `npm *test* :cat:` now", [], new Set(["cat"]))).toEqual([
      { kind: "text", text: "run " },
      formatted("code", { kind: "text", text: "npm *test* :cat:" }),
      { kind: "text", text: " now" },
    ]);
  });

  it("inline code never spans a newline", () => {
    expect(segmentMessageContent("`a\nb`", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "`a\nb`" },
    ]);
  });

  it("a URL swallows its own asterisks — the link pass runs first", () => {
    expect(segmentMessageContent("see https://host/*path*/x", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://host/*path*/x", url: "https://host/*path*/x" },
    ]);
  });

  it("a link inside a formatted span still becomes a link segment", () => {
    expect(segmentMessageContent("**see https://host/x now**", [], NO_EMOJIS)).toEqual([
      formatted("bold",
        { kind: "text", text: "see " },
        { kind: "link", text: "https://host/x", url: "https://host/x" },
        { kind: "text", text: " now" }),
    ]);
  });

  it("the emoji pass runs inside formatted content too", () => {
    expect(segmentMessageContent("**hi :cat:**", [], new Set(["cat"]))).toEqual([
      formatted("bold",
        { kind: "text", text: "hi " },
        { kind: "emoji", text: ":cat:", name: "cat" }),
    ]);
  });

  it("mentions are never formatted — markers only touch the gaps", () => {
    const segments = segmentMessageContent("**@alice**", [{ type: "USER", id: 1, name: "alice", start: 2, end: 8 }], NO_EMOJIS);
    expect(segments).toEqual([
      { kind: "text", text: "**" },
      { kind: "mention", text: "@alice", mention: expect.objectContaining({ start: 2, end: 8 }) },
      { kind: "text", text: "**" },
    ]);
  });

  it("a run of bare asterisks stays plain text", () => {
    expect(segmentMessageContent("***", [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "***" },
    ]);
    expect(segmentMessageContent("*".repeat(4000), [], NO_EMOJIS)).toEqual([
      { kind: "text", text: "*".repeat(4000) },
    ]);
  });

  it("spoiler and strike may wrap each other", () => {
    expect(segmentMessageContent("~~a ||b|| c~~", [], NO_EMOJIS)).toEqual([
      formatted("strike",
        { kind: "text", text: "a " },
        formatted("spoiler", { kind: "text", text: "b" }),
        { kind: "text", text: " c" }),
    ]);
  });
});
