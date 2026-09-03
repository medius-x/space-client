import { describe, expect, it } from "vitest";
import { GROUP_GAP_MS, computeGroupStarts, toEpochMs } from "../src/domain/logic/message-grouping";

const MINUTE = 60_000;

function entry(id: number, author: string, minutes: number) {
  return { id, authorUsername: author, createdAtEpochMs: minutes * MINUTE };
}

describe("computeGroupStarts", () => {
  it("starts a group on the first message and on every author change", () => {
    const flags = computeGroupStarts([
      entry(1, "alice", 0),
      entry(2, "alice", 1),
      entry(3, "bob", 2),
      entry(4, "bob", 3),
      entry(5, "alice", 4),
    ]);
    expect(flags).toEqual([true, false, true, false, true]);
  });

  it("continues within the gap window and breaks at exactly gap+1 ms", () => {
    const base = 1_000_000;
    const flags = computeGroupStarts([
      { id: 1, authorUsername: "alice", createdAtEpochMs: base },
      { id: 2, authorUsername: "alice", createdAtEpochMs: base + GROUP_GAP_MS },
      { id: 3, authorUsername: "alice", createdAtEpochMs: base + GROUP_GAP_MS + GROUP_GAP_MS + 1 },
    ], GROUP_GAP_MS);
    expect(flags).toEqual([true, false, true]);
  });

  it("honors a custom gap", () => {
    const flags = computeGroupStarts([
      entry(1, "alice", 0),
      entry(2, "alice", 2), // 2 min — inside the default 5 min, outside a 1 min window
    ], 1 * MINUTE);
    expect(flags).toEqual([true, true]);
  });

  it("empty and single-message lists", () => {
    expect(computeGroupStarts([])).toEqual([]);
    expect(computeGroupStarts([entry(1, "alice", 0)])).toEqual([true]);
  });

  it("toEpochMs parses ISO strings and maps garbage to 0", () => {
    expect(toEpochMs("2026-09-04T10:15:30.123Z")).toBe(Date.parse("2026-09-04T10:15:30.123Z"));
    expect(toEpochMs("not a date")).toBe(0);
  });
});
