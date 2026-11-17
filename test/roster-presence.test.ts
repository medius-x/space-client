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

/** The AFK dimension (2026-11-04): the same snapshot/delta discipline as presence. */
describe("RosterStore afk race", () => {
  it("flips racing the snapshot are replayed OVER it", () => {
    const store = new RosterStore();
    store.beginAfkSnapshot();
    store.applyAfkEvent({ username: "bob", afk: true });
    store.setVoiceAfk([]); // stale server answer without bob
    expect(store.getSnapshot().afk.has("bob")).toBe(true);
  });

  it("a returning member leaves the set, a no-op flip keeps it as-is", () => {
    const store = new RosterStore();
    store.setVoiceAfk(["bob"]);
    store.applyAfkEvent({ username: "bob", afk: true }); // already away — no change
    expect(store.getSnapshot().afk.has("bob")).toBe(true);
    store.applyAfkEvent({ username: "bob", afk: false }); // fresh heartbeat
    expect(store.getSnapshot().afk.has("bob")).toBe(false);
  });

  it("going offline drops the AFK tint (the grey dot wins)", () => {
    const store = new RosterStore();
    store.setVoiceAfk(["bob"]);
    store.applyPresenceEvent({ username: "bob", status: "OFFLINE" } as PresenceEvent);
    expect(store.getSnapshot().afk.has("bob")).toBe(false);
  });

  it("a failed snapshot unbufers onto the current state", () => {
    const store = new RosterStore();
    store.beginAfkSnapshot();
    store.applyAfkEvent({ username: "bob", afk: true });
    store.abortAfkSnapshot();
    expect(store.getSnapshot().afk.has("bob")).toBe(true);
  });
});

/** The STATUS dimension (the status menu, 2026-11-17): the same snapshot/delta
 *  discipline as presence, over the away/dnd sets. */
describe("RosterStore status race", () => {
  it("flips racing the snapshot are replayed OVER it", () => {
    const store = new RosterStore();
    store.beginStatusSnapshot();
    store.applyStatusEvent({ username: "bob", status: "dnd" });
    store.applyStatusEvent({ username: "carol", status: "online" });
    store.setStatuses({ away: [], dnd: [] }); // stale server answer
    expect(store.getSnapshot().statuses.get("bob")).toBe("dnd"); // the buffered flip survives
    expect(store.getSnapshot().statuses.has("carol")).toBe(false); // the buffered clear survives
  });

  it("last write per user wins inside the buffer", () => {
    const store = new RosterStore();
    store.beginStatusSnapshot();
    store.applyStatusEvent({ username: "bob", status: "away" });
    store.applyStatusEvent({ username: "bob", status: "dnd" });
    store.setStatuses({ away: [], dnd: [] });
    expect(store.getSnapshot().statuses.get("bob")).toBe("dnd");
  });

  it("a no-op flip keeps the state as-is; online removes the entry", () => {
    const store = new RosterStore();
    store.setStatuses({ away: ["bob"], dnd: [] });
    store.applyStatusEvent({ username: "bob", status: "away" }); // already away
    expect(store.getSnapshot().statuses.get("bob")).toBe("away");
    store.applyStatusEvent({ username: "bob", status: "online" });
    expect(store.getSnapshot().statuses.has("bob")).toBe(false);
  });

  it("going offline drops the status tint (the grey dot wins)", () => {
    const store = new RosterStore();
    store.setStatuses({ away: ["bob"], dnd: ["carol"] });
    store.applyPresenceEvent({ username: "bob", status: "OFFLINE" } as PresenceEvent);
    store.applyPresenceEvent({ username: "carol", status: "OFFLINE" } as PresenceEvent);
    expect(store.getSnapshot().statuses.has("bob")).toBe(false);
    expect(store.getSnapshot().statuses.has("carol")).toBe(false);
  });

  it("a failed snapshot unbufers onto the current state", () => {
    const store = new RosterStore();
    store.beginStatusSnapshot();
    store.applyStatusEvent({ username: "bob", status: "away" });
    store.abortStatusSnapshot();
    expect(store.getSnapshot().statuses.get("bob")).toBe("away");
  });
});
