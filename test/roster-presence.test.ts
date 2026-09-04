import { describe, expect, it } from "vitest";
import { RosterStore } from "../src/domain/stores/RosterStore";
import type { PresenceEvent } from "../src/types";

/** The snapshot/delta race (live M5 smoke: a peer connecting during our startup
 *  window showed OFFLINE forever on one side only). */
describe("RosterStore presence race", () => {
  it("deltas arriving while the snapshot is in flight are replayed OVER it", () => {
    const store = new RosterStore();
    store.beginPresenceSnapshot();
    store.applyPresenceEvent({ username: "bob", status: "ONLINE" } as PresenceEvent);
    store.applyPresenceEvent({ username: "carol", status: "OFFLINE" } as PresenceEvent);
    store.setPresence(["carol"]); // stale server answer: bob absent, carol present
    expect(store.getSnapshot().presence.has("bob")).toBe(true); // the buffered ONLINE survives
    expect(store.getSnapshot().presence.has("carol")).toBe(false); // the buffered OFFLINE survives
  });

  it("last write per user wins inside the buffer", () => {
    const store = new RosterStore();
    store.beginPresenceSnapshot();
    store.applyPresenceEvent({ username: "bob", status: "ONLINE" } as PresenceEvent);
    store.applyPresenceEvent({ username: "bob", status: "OFFLINE" } as PresenceEvent);
    store.setPresence([]);
    expect(store.getSnapshot().presence.has("bob")).toBe(false);
  });

  it("deltas after the snapshot apply directly", () => {
    const store = new RosterStore();
    store.beginPresenceSnapshot();
    store.setPresence(["alice"]);
    store.applyPresenceEvent({ username: "alice", status: "OFFLINE" } as PresenceEvent);
    expect(store.getSnapshot().presence.has("alice")).toBe(false);
  });

  it("a failed snapshot unbufers onto the current state instead of buffering forever", () => {
    const store = new RosterStore();
    store.beginPresenceSnapshot();
    store.applyPresenceEvent({ username: "bob", status: "ONLINE" } as PresenceEvent);
    store.abortPresenceSnapshot();
    expect(store.getSnapshot().presence.has("bob")).toBe(true);
    // The buffer is closed — later deltas apply directly again.
    store.applyPresenceEvent({ username: "bob", status: "OFFLINE" } as PresenceEvent);
    expect(store.getSnapshot().presence.has("bob")).toBe(false);
  });
});
