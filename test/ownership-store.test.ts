import { describe, expect, it } from "vitest";
import { OwnershipStore } from "../src/domain/stores/OwnershipStore";
import type { OwnershipTransfer } from "../src/types";

function transfer(id: number, status: OwnershipTransfer["status"]): OwnershipTransfer {
  return {
    id,
    fromUserId: 1,
    fromUsername: "from",
    fromDisplayName: "From",
    toUserId: 2,
    toUsername: "to",
    toDisplayName: "To",
    status,
    createdAt: "2026-10-01T10:00:00Z",
  };
}

describe("OwnershipStore", () => {
  it("starts unloaded with no pending offer", () => {
    const store = new OwnershipStore();
    expect(store.getSnapshot()).toEqual({ loaded: false, pending: null });
  });

  it("applies the wire snapshot verbatim (identity stable until the next apply)", () => {
    const store = new OwnershipStore();
    const pending = transfer(5, "PENDING");
    store.applySnapshot(pending);
    const first = store.getSnapshot();
    expect(first).toEqual({ loaded: true, pending });
    store.applySnapshot(pending);
    // a fresh snapshot object every apply — the banner re-renders on every push
    expect(store.getSnapshot()).not.toBe(first);
  });

  it("clear returns to the unloaded state", () => {
    const store = new OwnershipStore();
    store.applySnapshot(transfer(5, "PENDING"));
    store.clear();
    expect(store.getSnapshot()).toEqual({ loaded: false, pending: null });
  });
});
