import { describe, expect, it } from "vitest";
import { moveRoleIdTowards } from "../src/domain/logic/role-drag";

describe("moveRoleIdTowards", () => {
  const ids = [1, 2, 3, 4];

  it("drops above the target from the upper half", () => {
    expect(moveRoleIdTowards(ids, 4, 2, false)).toEqual([1, 4, 2, 3]);
  });

  it("drops below the target from the lower half", () => {
    expect(moveRoleIdTowards(ids, 1, 2, true)).toEqual([2, 1, 3, 4]);
  });

  it("hovering the dragged role itself is a no-op with the same reference", () => {
    expect(moveRoleIdTowards(ids, 2, 2, true)).toBe(ids);
  });

  it("hovering the same spot returns the same reference (no churn)", () => {
    // 2 already sits directly below 1 — a below-hover over 1 changes nothing.
    expect(moveRoleIdTowards(ids, 2, 1, true)).toBe(ids);
    // 2 already sits directly above 3 — an above-hover over 3 changes nothing.
    expect(moveRoleIdTowards(ids, 2, 3, false)).toBe(ids);
  });

  it("hovering the pinned everyone row appends to the end", () => {
    expect(moveRoleIdTowards(ids, 2, null, false)).toEqual([1, 3, 4, 2]);
  });

  it("an unknown target falls back to the end of the list", () => {
    expect(moveRoleIdTowards(ids, 2, 99, true)).toEqual([1, 3, 4, 2]);
  });

  it("repeated application is idempotent (preview then drop)", () => {
    const preview = moveRoleIdTowards(ids, 4, 1, false);
    const dropped = moveRoleIdTowards(preview, 4, 1, false);
    expect(dropped).toBe(preview);
  });
});
