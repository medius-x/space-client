import { describe, expect, it } from "vitest";
import { clipProgressLine, formatByteProgress } from "../src/domain/provisioning/progress";

describe("formatByteProgress", () => {
  it("renders megabytes with one decimal and the floored percent", () => {
    expect(formatByteProgress(40 * 1024 * 1024, 80 * 1024 * 1024)).toBe("40.0 / 80.0 MB · 50%");
  });

  it("caps the percent at 100 (a chunk overshoot must not read as 101%)", () => {
    expect(formatByteProgress(81 * 1024 * 1024, 80 * 1024 * 1024)).toBe("81.0 / 80.0 MB · 100%");
  });

  it("degenerate inputs collapse to an empty string (never NaN on screen)", () => {
    expect(formatByteProgress(Number.NaN, 100)).toBe("");
    expect(formatByteProgress(10, 0)).toBe("");
    expect(formatByteProgress(-1, 100)).toBe("");
  });
});

describe("clipProgressLine", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(clipProgressLine("  Unpacking   docker-ce  (23 MB) \n")).toBe("Unpacking docker-ce (23 MB)");
  });

  it("keeps the head of an over-long line with an ellipsis", () => {
    const clipped = clipProgressLine("x".repeat(100), 72);
    expect(clipped.length).toBe(72);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("an empty/blank line collapses to an empty string", () => {
    expect(clipProgressLine("   ")).toBe("");
  });
});
