import { describe, expect, it } from "vitest";
import { VoiceControlStore } from "../src/domain/stores/VoiceControlStore";
import { knockSchedule } from "../src/domain/logic/knock-sound";
import { MAX_VOICE_REJOIN_ATTEMPTS, rejoinDelayMs, rejoinExhausted } from "../src/domain/logic/rejoin-ladder";
import type { VoiceControlState } from "../src/types";

function push(overrides: Partial<VoiceControlState>): VoiceControlState {
  return {
    username: "alice",
    channelId: 7,
    muted: false,
    deafened: false,
    selfMuted: false,
    selfDeafened: false,
    modMuted: false,
    modDeafened: false,
    permMuted: false,
    ...overrides,
  };
}

describe("VoiceControlStore", () => {
  it("keeps the ORIGIN flags verbatim — no union∖self derivation", () => {
    const store = new VoiceControlStore();
    store.applyState(push({ selfMuted: true, modMuted: true, muted: true }));
    expect(store.marksFor("alice")).toEqual({
      selfMuted: true,
      selfDeafened: false,
      modMuted: true,
      modDeafened: false,
      permMuted: false,
    });
  });

  it("carries the SPEAK-permission flag verbatim (security round 6)", () => {
    const store = new VoiceControlStore();
    store.applyState(push({ permMuted: true, muted: true }));
    const marks = store.marksFor("alice");
    expect(marks.permMuted).toBe(true);
    expect(marks.modMuted).toBe(false); // the UI paints it red, but the tooltip differs
  });

  it("the self-toggle reads only the self flag while the union is derivable", () => {
    const store = new VoiceControlStore();
    store.applyState(push({ selfMuted: false, modMuted: true, muted: true }));
    const marks = store.marksFor("alice");
    expect(marks.selfMuted).toBe(false); // toggle target — unmuted
    expect(marks.selfMuted || marks.modMuted).toBe(true); // compliance union
  });

  it("a later push replaces the member's marks entirely", () => {
    const store = new VoiceControlStore();
    store.applyState(push({ modDeafened: true }));
    store.applyState(push({ selfMuted: true, modDeafened: false }));
    expect(store.marksFor("alice").modDeafened).toBe(false);
    expect(store.marksFor("alice").selfMuted).toBe(true);
  });

  it("clearUser drops the marks of a member who left the room", () => {
    const store = new VoiceControlStore();
    store.applyState(push({ modMuted: true }));
    const before = store.getSnapshot();
    store.clearUser("alice");
    expect(store.getSnapshot().marks.has("alice")).toBe(false);
    expect(before).not.toBe(store.getSnapshot()); // new snapshot object — re-render fires
  });

  it("clearUser on an absent member is a no-op (no emit)", () => {
    const store = new VoiceControlStore();
    expect(store.getSnapshot().marks.size).toBe(0);
    store.clearUser("nobody");
    expect(store.getSnapshot().marks.size).toBe(0);
  });

  it("marksFor of an unknown member is all-false", () => {
    const store = new VoiceControlStore();
    expect(store.marksFor("stranger")).toEqual({
      selfMuted: false,
      selfDeafened: false,
      modMuted: false,
      modDeafened: false,
      permMuted: false,
    });
  });
});

describe("rejoin ladder", () => {
  it("delays are 1/2/4/8/8 s across five attempts", () => {
    expect([1, 2, 3, 4, 5].map(rejoinDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("out-of-range attempts clamp to the ladder bounds", () => {
    expect(rejoinDelayMs(0)).toBe(1_000);
    expect(rejoinDelayMs(99)).toBe(8_000);
  });

  it("the ladder is exhausted exactly after the fifth attempt fails", () => {
    expect(rejoinExhausted(4)).toBe(false);
    expect(rejoinExhausted(MAX_VOICE_REJOIN_ATTEMPTS)).toBe(true);
    expect(rejoinExhausted(6)).toBe(true);
  });
});

describe("knockSchedule", () => {
  it("join knocks go UP (150 then 210), leave goes DOWN", () => {
    expect(knockSchedule("join").map((note) => note.frequencyHz)).toEqual([150, 210]);
    expect(knockSchedule("leave").map((note) => note.frequencyHz)).toEqual([210, 150]);
  });

  it("the second knock starts after the full note+gap of the first", () => {
    const [first, second] = knockSchedule("join");
    expect(first!.startSeconds).toBe(0);
    expect(second!.startSeconds).toBe(first!.startSeconds + first!.durationSeconds + 0.08);
  });
});
