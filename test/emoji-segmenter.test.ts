import { describe, expect, it } from "vitest";
import { segmentMessageContent } from "../src/domain/logic/mention-segmenter";
import type { MentionInfo } from "../src/types";

const NAMES = new Set(["cat", "doge", "b"]);

function mentionOf(start: number, end: number): MentionInfo {
  return { type: "USER", id: 1, name: "alice", start, end };
}

describe("segmentMessageContent — custom emoji pass", () => {
  it("a catalog token inside a text gap becomes an emoji segment", () => {
    const segments = segmentMessageContent("hello :cat: world", [], NAMES);
    expect(segments).toEqual([
      { kind: "text", text: "hello " },
      { kind: "emoji", text: ":cat:", name: "cat" },
      { kind: "text", text: " world" },
    ]);
  });

  it("a URL with a port is never cut — the emoji pass runs after the link pass", () => {
    const segments = segmentMessageContent("see http://host:8080/x :cat:", [], NAMES);
    expect(segments).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "http://host:8080/x", url: "http://host:8080/x" },
      { kind: "text", text: " " },
      { kind: "emoji", text: ":cat:", name: "cat" },
    ]);
  });

  it("a token outside the catalog stays plain text (deleted emoji degradation)", () => {
    const segments = segmentMessageContent("plain :ghost: text", [], NAMES);
    expect(segments).toEqual([{ kind: "text", text: "plain :ghost: text" }]);
  });

  it("a partial-catalog pair still finds the member token (:a:b: with only b)", () => {
    const segments = segmentMessageContent(":a:b:", [], NAMES);
    expect(segments).toEqual([
      { kind: "text", text: ":a" },
      { kind: "emoji", text: ":b:", name: "b" },
    ]);
  });

  it("adjacent tokens both resolve", () => {
    const segments = segmentMessageContent(":cat::doge:", [], NAMES);
    expect(segments).toEqual([
      { kind: "emoji", text: ":cat:", name: "cat" },
      { kind: "emoji", text: ":doge:", name: "doge" },
    ]);
  });

  it("mentions keep their server offsets — the emoji pass only touches the gaps", () => {
    // "hi @alice and :cat:" — the mention spans [3,9).
    const segments = segmentMessageContent("hi @alice and :cat:", [mentionOf(3, 9)], NAMES);
    expect(segments).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", text: "@alice", mention: expect.objectContaining({ start: 3, end: 9 }) },
      { kind: "text", text: " and " },
      { kind: "emoji", text: ":cat:", name: "cat" },
    ]);
  });

  it("without a name set the behavior is byte-identical to the old segmentation", () => {
    expect(segmentMessageContent("hello :cat: world", [])).toEqual([
      { kind: "text", text: "hello :cat: world" },
    ]);
  });
});
