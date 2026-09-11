import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "../src/domain/logic/color";

describe("hsvToHex / hexToHsv", () => {
  it("round-trips arbitrary colors", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#5865f2", "#f0b232", "#99aab5", "#123456"]) {
      const back = hsvToHex(hexToHsv(hex));
      expect(back).toBe(hex);
    }
  });

  it("maps the hue wheel and the achromatic corners", () => {
    expect(hsvToHex({ hue: 0, saturation: 1, value: 1 })).toBe("#ff0000");
    expect(hsvToHex({ hue: 120, saturation: 1, value: 1 })).toBe("#00ff00");
    expect(hsvToHex({ hue: 240, saturation: 1, value: 1 })).toBe("#0000ff");
    expect(hsvToHex({ hue: 0, saturation: 0, value: 0 })).toBe("#000000");
    expect(hsvToHex({ hue: 0, saturation: 0, value: 1 })).toBe("#ffffff");
    expect(hsvToHex({ hue: 60, saturation: 1, value: 0.5 })).toBe("#808000");
  });

  it("normalizes out-of-range hue and parses with or without '#'", () => {
    expect(hsvToHex({ hue: 720, saturation: 1, value: 1 })).toBe("#ff0000");
    expect(hexToHsv("5865f2")).toEqual(hexToHsv("#5865f2"));
    // garbage maps to black rather than throwing
    expect(hexToHsv("nope")).toEqual({ hue: 0, saturation: 0, value: 0 });
  });
});
