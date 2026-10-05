import { describe, expect, it } from "vitest";
import { dmBlockHintText, dmSendBlockReason } from "../src/domain/logic/dm-gating";

describe("dmSendBlockReason", () => {
  it("returns null for an unrestricted 1:1", () => {
    expect(dmSendBlockReason(false, false, false)).toBeNull();
  });

  it("blocks the restricted member themselves in every shape", () => {
    expect(dmSendBlockReason(true, false, false)).toBe("self");
    expect(dmSendBlockReason(true, true, false)).toBe("self");
    expect(dmSendBlockReason(true, false, true)).toBe("self");
  });

  it("freezes a 1:1 toward a restricted peer for the clean side too", () => {
    expect(dmSendBlockReason(false, true, false)).toBe("peer");
  });

  it("keeps a group DM writable when only a member is restricted", () => {
    expect(dmSendBlockReason(false, true, true)).toBeNull();
    expect(dmSendBlockReason(false, null, true)).toBeNull();
  });

  it("treats an unknown peer state (roster not loaded yet) as unrestricted", () => {
    expect(dmSendBlockReason(false, null, false)).toBeNull();
  });
});

describe("dmBlockHintText", () => {
  it("names the two restriction sides distinctly", () => {
    expect(dmBlockHintText("self")).toContain("You are not allowed");
    expect(dmBlockHintText("peer")).toContain("cannot receive");
  });
});
