import { describe, expect, it } from "vitest";
import { paletteColor, USER_PALETTE } from "../src/domain/logic/user-palette";
import { formatHeaderStamp } from "../src/domain/logic/message-grouping";

describe("paletteColor (oak's deterministic username wheel)", () => {
  it("is stable and always one of the palette colors", () => {
    for (const username of ["alice", "bob", "карл", "x", "very-long-username-123"]) {
      const color = paletteColor(username);
      expect(color).toBe(paletteColor(username)); // deterministic
      expect(USER_PALETTE).toContain(color);
    }
  });

  it("spreads different names across the wheel (not all one bucket)", () => {
    const colors = new Set(["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"].map(paletteColor));
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });
});

describe("formatHeaderStamp (oak's message header)", () => {
  const now = new Date(2026, 8, 5, 15, 0, 0).getTime(); // Sep 5 2026, 15:00 local
  it("uses Today/Yesterday windows and falls back to 'Mon D at HH:mm'", () => {
    expect(formatHeaderStamp(now - 60_000, now)).toBe("Today at 14:59");
    expect(formatHeaderStamp(now - 26 * 3_600_000, now)).toBe("Yesterday at 13:00");
    expect(formatHeaderStamp(new Date(2026, 7, 20, 9, 5).getTime(), now)).toBe("Aug 20 at 09:05");
  });
});
