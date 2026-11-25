import { describe, expect, it } from "vitest";
import { formatPollRemaining } from "../src/domain/logic/poll-time";

const NOW = Date.parse("2026-11-25T12:00:00Z");
/** A deadline `minutes` away from NOW. */
function inMinutes(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

describe("formatPollRemaining (the user's rule: days past a day, hours under it, minutes under an hour)", () => {
  it("more than a day renders whole days", () => {
    expect(formatPollRemaining(inMinutes(60 * 24), NOW)).toBe("1 d");
    expect(formatPollRemaining(inMinutes(60 * 24 * 3 + 5 * 60), NOW)).toBe("3 d");
  });

  it("less than a day but more than an hour renders hours", () => {
    expect(formatPollRemaining(inMinutes(60), NOW)).toBe("1 h");
    expect(formatPollRemaining(inMinutes(23 * 60 + 59), NOW)).toBe("23 h"); // a minute short of a day
    expect(formatPollRemaining(inMinutes(5 * 60), NOW)).toBe("5 h");
  });

  it("less than an hour renders minutes (ceil — 1 s left is still a minute)", () => {
    expect(formatPollRemaining(inMinutes(59), NOW)).toBe("59 min");
    expect(formatPollRemaining(new Date(NOW + 1000).toISOString(), NOW)).toBe("1 min");
  });

  it("a passed deadline reads zero minutes (the closed push flips the card anyway)", () => {
    expect(formatPollRemaining(new Date(NOW - 1000).toISOString(), NOW)).toBe("0 min");
  });
});
