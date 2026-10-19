import { describe, expect, it } from "vitest";
import { applyRailDrop, sanitizeRailOrder, sortRecordsForRail } from "../src/domain/logic/rail-drag";

describe("applyRailDrop", () => {
  const ids = ["a", "b", "c", "d"];

  it("drops above the target from the upper half", () => {
    expect(applyRailDrop(ids, "d", "b", false)).toEqual(["a", "d", "b", "c"]);
  });

  it("drops below the target from the lower half", () => {
    expect(applyRailDrop(ids, "a", "b", true)).toEqual(["b", "a", "c", "d"]);
  });

  it("hovering the dragged row itself is a no-op with the same reference", () => {
    expect(applyRailDrop(ids, "b", "b", true)).toBe(ids);
  });

  it("hovering the same spot returns the same reference (no churn)", () => {
    // "b" already sits directly below "a" — a below-hover over "a" changes nothing.
    expect(applyRailDrop(ids, "b", "a", true)).toBe(ids);
    // "b" already sits directly above "c" — an above-hover over "c" changes nothing.
    expect(applyRailDrop(ids, "b", "c", false)).toBe(ids);
  });

  it("a null target (below every row) appends to the end", () => {
    expect(applyRailDrop(ids, "b", null, false)).toEqual(["a", "c", "d", "b"]);
  });

  it("an unknown target falls back to the end of the list", () => {
    expect(applyRailDrop(ids, "b", "zzz", true)).toEqual(["a", "c", "d", "b"]);
  });

  it("repeated application is idempotent (preview then drop)", () => {
    const preview = applyRailDrop(ids, "d", "a", false);
    const dropped = applyRailDrop(preview, "d", "a", false);
    expect(dropped).toBe(preview);
  });
});

describe("sortRecordsForRail", () => {
  const recordOf = (id: string, createdAt: number): { id: string; createdAt: number } => ({ id, createdAt });

  it("with no manual order, records follow join order (createdAt asc)", () => {
    const records = [recordOf("late", 300), recordOf("early", 100), recordOf("middle", 200)];
    expect(sortRecordsForRail(records, []).map((record) => record.id)).toEqual(["early", "middle", "late"]);
  });

  it("the manual order wins for the records it lists", () => {
    const records = [recordOf("a", 100), recordOf("b", 200), recordOf("c", 300)];
    expect(sortRecordsForRail(records, ["c", "a"]).map((record) => record.id)).toEqual(["c", "a", "b"]);
  });

  it("records missing from the order append after the positioned ones by join order", () => {
    const records = [recordOf("a", 100), recordOf("b", 200), recordOf("c", 300), recordOf("d", 400)];
    expect(sortRecordsForRail(records, ["d", "b"]).map((record) => record.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("equal createdAt ties break by id — the sort is fully deterministic", () => {
    const records = [recordOf("bbb", 100), recordOf("aaa", 100), recordOf("ccc", 100)];
    expect(sortRecordsForRail(records, []).map((record) => record.id)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("dead ids in the order are ignored; duplicate ids count once (first wins)", () => {
    const records = [recordOf("a", 100), recordOf("b", 200)];
    expect(sortRecordsForRail(records, ["ghost", "b", "b", "ghost", "a"]).map((record) => record.id))
      .toEqual(["b", "a"]);
  });

  it("lastUsedAt plays no part — recency never reshuffles the rail", () => {
    const records = [
      { id: "old-joined", createdAt: 100, lastUsedAt: 900 },
      { id: "new-joined", createdAt: 200, lastUsedAt: 10 },
    ];
    expect(sortRecordsForRail(records, []).map((record) => record.id)).toEqual(["old-joined", "new-joined"]);
  });
});

describe("sanitizeRailOrder", () => {
  it("keeps a plain string array as-is", () => {
    expect(sanitizeRailOrder(["b", "a"])).toEqual(["b", "a"]);
  });

  it("garbage collapses to an empty order", () => {
    expect(sanitizeRailOrder(null)).toEqual([]);
    expect(sanitizeRailOrder("a,b")).toEqual([]);
    expect(sanitizeRailOrder({ 0: "a" })).toEqual([]);
  });

  it("drops non-string entries and dedups, keeping the first occurrence", () => {
    expect(sanitizeRailOrder(["a", 7, "b", "a", null, "b"])).toEqual(["a", "b"]);
  });
});
