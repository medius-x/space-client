import { describe, expect, it } from "vitest";
import {
  AFK_IDLE_GRACE_SECONDS,
  ROSTER_AFK_AFTER_SECONDS,
  isAfkActive,
  isRosterAway,
} from "../src/domain/logic/afk-activity";

describe("isAfkActive", () => {
  it("fresh input is active", () => {
    expect(isAfkActive(0, false)).toBe(true);
  });

  it("the grace boundary: 59 s active, 60 s idle", () => {
    expect(isAfkActive(AFK_IDLE_GRACE_SECONDS - 1, false)).toBe(true);
    expect(isAfkActive(AFK_IDLE_GRACE_SECONDS, false)).toBe(false);
  });

  it("speaking keeps the member active however old the input idle is", () => {
    expect(isAfkActive(Number.POSITIVE_INFINITY, true)).toBe(true);
    expect(isAfkActive(999_999, true)).toBe(true);
  });

  it("an outgoing screen share or camera keeps the member active", () => {
    // A member actively showing something is present by definition — a cold
    // input idle timer (watching, not touching) must not sweep them to AFK.
    expect(isAfkActive(Number.POSITIVE_INFINITY, false, true)).toBe(true);
    expect(isAfkActive(999_999, false, true)).toBe(true);
  });

  it("streaming without speaking and without input is still active; the default stays idle", () => {
    expect(isAfkActive(AFK_IDLE_GRACE_SECONDS, false, true)).toBe(true);
    expect(isAfkActive(AFK_IDLE_GRACE_SECONDS, false, false)).toBe(false);
  });
});

describe("isRosterAway", () => {
  it("the roster threshold: 299 s present, 300 s away (user decision: 5 minutes)", () => {
    expect(isRosterAway(ROSTER_AFK_AFTER_SECONDS - 1, false)).toBe(false);
    expect(isRosterAway(ROSTER_AFK_AFTER_SECONDS, false)).toBe(true);
  });

  it("speaking in voice keeps the member present however old the input idle is", () => {
    expect(isRosterAway(Number.POSITIVE_INFINITY, true)).toBe(false);
    expect(isRosterAway(999_999, true)).toBe(false);
  });

  it("an outgoing screen share or camera keeps the member present", () => {
    expect(isRosterAway(Number.POSITIVE_INFINITY, false, true)).toBe(false);
  });

  it("a member in the voice-idle grace window is NOT yet roster-away (60 s ≪ 300 s)", () => {
    // The two thresholds are separate entities: the sweep grace is 60 s, the
    // roster dot needs the full 5 minutes.
    expect(isAfkActive(AFK_IDLE_GRACE_SECONDS, false)).toBe(false);
    expect(isRosterAway(AFK_IDLE_GRACE_SECONDS, false)).toBe(false);
  });
});
