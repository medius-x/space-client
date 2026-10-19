import { describe, expect, it } from "vitest";
import {
  GROUP_GAP_MS,
  computeGroupStarts,
  continuesGroup,
  formatHeaderStamp,
  formatTimeOfDay,
  toEpochMs,
} from "../src/domain/logic/message-grouping";

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
});

describe("continuesGroup (pagination boundary alignment)", () => {
  it("same author inside the window continues; author change or gap breaks", () => {
    expect(continuesGroup(entry(1, "alice", 0), entry(2, "alice", 4))).toBe(true);
    expect(continuesGroup(entry(1, "alice", 0), entry(2, "bob", 1))).toBe(false);
    expect(continuesGroup(entry(1, "alice", 0), entry(2, "alice", 6))).toBe(false);
  });

  it("agrees with computeGroupStarts on the boundary flag", () => {
    const older = entry(1, "alice", 10);
    const newer = entry(2, "alice", 12);
    const flags = computeGroupStarts([older, newer]);
    expect(flags[1]).toBe(!continuesGroup(older, newer));
  });

  it("toEpochMs parses ISO strings and maps garbage to 0", () => {
    expect(toEpochMs("2026-09-04T10:15:30.123Z")).toBe(Date.parse("2026-09-04T10:15:30.123Z"));
    expect(toEpochMs("not a date")).toBe(0);
  });
});

describe("timestamp formatters (cached Intl instances)", () => {
  const HOUR = 3_600_000;
  // LOCAL-component dates: the Today/Yesterday logic compares local calendar
  // days, so the arithmetic must stay inside one local day on ANY host tz.
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime(); // Oct 19 2026, local noon

  it("formatTimeOfDay matches the one-shot toLocaleTimeString it replaced", () => {
    const sample = new Date(2026, 9, 19, 14, 5).getTime();
    expect(formatTimeOfDay(sample))
      .toBe(new Date(sample).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });

  it("formatHeaderStamp renders Today/Yesterday and the full date for older days", () => {
    expect(formatHeaderStamp(now - 2 * HOUR, now)).toMatch(/^Today at \d{2}:\d{2}$/);
    expect(formatHeaderStamp(now - 26 * HOUR, now)).toMatch(/^Yesterday at \d{2}:\d{2}$/);
    // Older: "<short month> <day> at HH:MM" (English month abbreviations, oak parity).
    const oldStamp = new Date(2026, 8, 4, 9, 30).getTime();
    expect(formatHeaderStamp(oldStamp, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2}$/);
    expect(formatHeaderStamp(oldStamp, now)).toMatch(/^Sep 4 at \d{2}:\d{2}$/);
  });

  it("relativeDates=false always shows the full date", () => {
    expect(formatHeaderStamp(now - 2 * HOUR, now, false)).toMatch(/^[A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2}$/);
    expect(formatHeaderStamp(now - 2 * HOUR, now, false)).not.toContain("Today");
  });
});
