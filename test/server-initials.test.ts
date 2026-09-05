import { describe, expect, it } from "vitest";
import { serverInitials } from "../src/domain/logic/server-initials";

describe("serverInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(serverInitials("My OAK")).toBe("MO");
    expect(serverInitials("production server")).toBe("PS");
  });

  it("uses a single letter for one-word names", () => {
    expect(serverInitials("oak")).toBe("O");
  });

  it("ignores extra words beyond the second", () => {
    expect(serverInitials("a b c d")).toBe("AB");
  });

  it("collapses whitespace and handles blanks", () => {
    expect(serverInitials("   spaced   out   ")).toBe("SO");
    expect(serverInitials("")).toBe("?");
    expect(serverInitials("   ")).toBe("?");
  });
});
