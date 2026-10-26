import { describe, expect, it } from "vitest";
import { AFK_IDLE_GRACE_SECONDS, isAfkActive } from "../src/domain/logic/afk-activity";

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
