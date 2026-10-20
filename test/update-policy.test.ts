import { describe, expect, it } from "vitest";
import {
  isDailyCheckDue,
  isIdleEnoughForUpdateCheck,
  isNewerVersion,
  shouldShowUpdateBanner,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_IDLE_THRESHOLD_SECONDS,
} from "../src/domain/logic/update-policy";

describe("update-policy idle gate", () => {
  it("15 minutes of system idle is the threshold (user decision 2026-10-20)", () => {
    expect(UPDATE_IDLE_THRESHOLD_SECONDS).toBe(15 * 60);
  });

  it("accepts at/after the threshold, rejects below it", () => {
    expect(isIdleEnoughForUpdateCheck(899)).toBe(false);
    expect(isIdleEnoughForUpdateCheck(900)).toBe(true);
    expect(isIdleEnoughForUpdateCheck(3_600)).toBe(true);
  });

  it("a missing idle bridge (Infinity) lets the scheduled check proceed", () => {
    // The bridge only vanishes on a stale preload; the probe is invisible and
    // the banner is static, so failing OPEN is the harmless reading.
    expect(isIdleEnoughForUpdateCheck(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("update-policy daily schedule", () => {
  it("is 24 hours between scheduled checks", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("fires at the boundary, not a millisecond before", () => {
    const startedAt = 1_700_000_000_000;
    expect(isDailyCheckDue(startedAt, startedAt + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(isDailyCheckDue(startedAt, startedAt + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });
});

describe("update-policy banner visibility", () => {
  it("needs a known version", () => {
    expect(shouldShowUpdateBanner(null, null)).toBe(false);
    expect(shouldShowUpdateBanner(null, "0.2.0")).toBe(false);
  });

  it("hides exactly the skipped version — the next release re-arms", () => {
    expect(shouldShowUpdateBanner("0.2.0", "0.2.0")).toBe(false);
    expect(shouldShowUpdateBanner("0.2.1", "0.2.0")).toBe(true);
    expect(shouldShowUpdateBanner("0.2.0", null)).toBe(true);
  });
});

describe("update-policy version comparison", () => {
  it("orders major/minor/patch numerically", () => {
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
  });

  it("equal and older versions are NOT newer", () => {
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.9", "0.2.0")).toBe(false);
  });

  it("compares numbers, not strings (0.10.0 beats 0.9.0)", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false);
  });

  it("garbage and pre-release suffixes never read as newer", () => {
    expect(isNewerVersion("oops", "0.1.0")).toBe(false);
    expect(isNewerVersion("1.2", "0.1.0")).toBe(false);
    expect(isNewerVersion("1.2.x", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "garbage")).toBe(false);
  });
});
