import { describe, expect, it } from "vitest";
import { flattenForSearch, formatSearchDayStamp, groupSearchResultsByDay, highlightSegments } from "../src/domain/logic/search-results";
import type { Message } from "../src/types";

function message(id: number, createdAt: string): Message {
  return {
    id,
    channelId: 5,
    authorId: 10,
    authorUsername: "alice",
    content: `m${id}`,
    createdAt,
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
  };
}

describe("highlightSegments (#481)", () => {
  it("splits around every case-insensitive hit, multi-hit included", () => {
    expect(highlightSegments("say hello and HELLO again", "hello")).toEqual([
      { text: "say ", hit: false },
      { text: "hello", hit: true },
      { text: " and ", hit: false },
      { text: "HELLO", hit: true },
      { text: " again", hit: false },
    ]);
  });

  it("treats the query as a LITERAL — LIKE/regex metacharacters are not special", () => {
    expect(highlightSegments("task 50_x and 50ax", "50_")).toEqual([
      { text: "task ", hit: false },
      { text: "50_", hit: true },
      { text: "x and 50ax", hit: false },
    ]);
  });

  it("matches Cyrillic case-insensitively", () => {
    expect(highlightSegments("ПРИВЕТ миру", "привет")).toEqual([
      { text: "ПРИВЕТ", hit: true },
      { text: " миру", hit: false },
    ]);
  });

  it("no hits / empty query / null content degenerate to one plain segment", () => {
    expect(highlightSegments("nothing here", "needle")).toEqual([{ text: "nothing here", hit: false }]);
    expect(highlightSegments("anything", "")).toEqual([{ text: "anything", hit: false }]);
    expect(highlightSegments(null, "needle")).toEqual([{ text: "", hit: false }]);
    expect(highlightSegments(null, null)).toEqual([{ text: "", hit: false }]);
  });
});

describe("flattenForSearch", () => {
  it("flattens newlines and caps with an ellipsis", () => {
    expect(flattenForSearch("line one\nline two")).toBe("line one line two");
    const long = "x".repeat(130);
    expect(flattenForSearch(long)).toBe("x".repeat(120) + "…");
    expect(flattenForSearch(null)).toBe("");
  });
});

describe("day grouping (#481)", () => {
  // Local calendar day boundaries; fixed instants interpreted in the runtime TZ.
  const NOW = new Date(2026, 8, 18, 12, 0, 0).getTime(); // Sep 18 2026, noon local

  it("labels Today / Yesterday / a bare month-day / month-day with year", () => {
    const today = new Date(2026, 8, 18, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 17, 23, 30, 0).getTime();
    const thisYear = new Date(2026, 3, 4, 10, 0, 0).getTime();
    const otherYear = new Date(2024, 8, 18, 10, 0, 0).getTime();
    expect(formatSearchDayStamp(today, NOW)).toBe("Today");
    expect(formatSearchDayStamp(yesterday, NOW)).toBe("Yesterday");
    expect(formatSearchDayStamp(thisYear, NOW)).toBe("Apr 4");
    expect(formatSearchDayStamp(otherYear, NOW)).toBe("Sep 18, 2024");
  });

  it("groups newest-first results into consecutive same-day buckets without re-sorting", () => {
    const groups = groupSearchResultsByDay([
      message(3, "2026-09-18T10:00:00Z"),
      message(2, "2026-09-18T08:00:00Z"),
      message(1, "2026-09-16T08:00:00Z"),
    ], NOW);
    expect(groups.map((group) => group.label)).toEqual([formatSearchDayStamp(Date.parse("2026-09-18T10:00:00Z"), NOW),
      formatSearchDayStamp(Date.parse("2026-09-16T08:00:00Z"), NOW)]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual([3, 2]);
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual([1]);
  });
});
