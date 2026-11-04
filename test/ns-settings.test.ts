import { describe, expect, it } from "vitest";
import {
  DEEP_FILTER_ATTEN_DEFAULT_DB,
  DEEP_FILTER_ATTEN_MAX_DB,
  DEEP_FILTER_ATTEN_MIN_DB,
  sanitizeDeepFilterSuppressionLevel,
} from "../src/domain/logic/ns-settings";

describe("DeepFilterNet3 suppression limit sanitization", () => {
  it("in-band values pass through (rounded)", () => {
    expect(sanitizeDeepFilterSuppressionLevel(15)).toBe(15);
    expect(sanitizeDeepFilterSuppressionLevel(6)).toBe(6);
    expect(sanitizeDeepFilterSuppressionLevel(40)).toBe(40);
    expect(sanitizeDeepFilterSuppressionLevel(23.6)).toBe(24);
  });

  it("the legacy default of 50 (≈ unlimited) clamps to the band maximum, intent preserved", () => {
    expect(sanitizeDeepFilterSuppressionLevel(50)).toBe(DEEP_FILTER_ATTEN_MAX_DB);
    expect(sanitizeDeepFilterSuppressionLevel(100)).toBe(DEEP_FILTER_ATTEN_MAX_DB);
  });

  it("the legacy 0 (no limiter = the strongest) remaps to the maximum, not the floor", () => {
    expect(sanitizeDeepFilterSuppressionLevel(0)).toBe(DEEP_FILTER_ATTEN_MAX_DB);
  });

  it("the legacy ultra-gentle 1..5 dB caps clamp up to the band floor", () => {
    expect(sanitizeDeepFilterSuppressionLevel(1)).toBe(DEEP_FILTER_ATTEN_MIN_DB);
    expect(sanitizeDeepFilterSuppressionLevel(5)).toBe(DEEP_FILTER_ATTEN_MIN_DB);
  });

  it("garbage restores the default", () => {
    expect(sanitizeDeepFilterSuppressionLevel("20")).toBe(DEEP_FILTER_ATTEN_DEFAULT_DB);
    expect(sanitizeDeepFilterSuppressionLevel(null)).toBe(DEEP_FILTER_ATTEN_DEFAULT_DB);
    expect(sanitizeDeepFilterSuppressionLevel(Number.NaN)).toBe(DEEP_FILTER_ATTEN_DEFAULT_DB);
    expect(sanitizeDeepFilterSuppressionLevel(undefined)).toBe(DEEP_FILTER_ATTEN_DEFAULT_DB);
  });
});
