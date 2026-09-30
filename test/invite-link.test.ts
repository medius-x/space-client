import { describe, expect, it } from "vitest";
import {
  buildInviteLink,
  formatExpiresIn,
  formatTtlWords,
  parseInviteLink,
} from "../src/domain/logic/invite-link";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function minutesFromNow(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

describe("parseInviteLink", () => {
  it("parses the canonical hash form into origin and secret", () => {
    expect(parseInviteLink("http://localhost:8080/#invite=abc123_DEF")).toEqual({
      origin: "http://localhost:8080",
      secret: "abc123_DEF",
    });
  });

  it("tolerates the ?invite= query variant", () => {
    expect(parseInviteLink("http://oak.lan:9000/?invite=s3cret")).toEqual({
      origin: "http://oak.lan:9000",
      secret: "s3cret",
    });
  });

  it("prefers the hash when both carry an invite", () => {
    expect(parseInviteLink("http://oak.lan/?invite=from-query#invite=from-hash&x=1")).toEqual({
      origin: "http://oak.lan",
      secret: "from-hash",
    });
  });

  it("cuts the secret at the next & fragment parameter", () => {
    expect(parseInviteLink("http://oak.lan/#invite=sec&foo=bar")).toEqual({
      origin: "http://oak.lan",
      secret: "sec",
    });
  });

  it("prepends http:// when the scheme is missing", () => {
    expect(parseInviteLink("oak.lan:8080/#invite=sec")).toEqual({
      origin: "http://oak.lan:8080",
      secret: "sec",
    });
  });

  it("keeps IPv6 brackets in the origin", () => {
    expect(parseInviteLink("http://[::1]:8080/#invite=sec")).toEqual({
      origin: "http://[::1]:8080",
      secret: "sec",
    });
  });

  it("normalizes a trailing path slash into a clean origin", () => {
    expect(parseInviteLink("https://oak.example.com/#invite=sec")?.origin).toBe("https://oak.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(parseInviteLink("  http://oak.lan/#invite=sec\n")).toEqual({
      origin: "http://oak.lan",
      secret: "sec",
    });
  });

  it("returns null for a link without a secret", () => {
    expect(parseInviteLink("http://oak.lan:8080/")).toBeNull();
    expect(parseInviteLink("http://oak.lan:8080/#")).toBeNull();
    expect(parseInviteLink("http://oak.lan:8080/#invite=")).toBeNull();
    expect(parseInviteLink("http://oak.lan:8080/#other=sec")).toBeNull();
  });

  it("returns null for non-links and empty input", () => {
    expect(parseInviteLink("")).toBeNull();
    expect(parseInviteLink("   ")).toBeNull();
    expect(parseInviteLink("not a link at all")).toBeNull();
    expect(parseInviteLink("http://")).toBeNull();
  });
});

describe("buildInviteLink", () => {
  it("assembles the canonical form and trims origin slashes", () => {
    expect(buildInviteLink("http://oak.lan:8080", "sec")).toBe("http://oak.lan:8080/#invite=sec");
    expect(buildInviteLink("http://oak.lan:8080/", "sec")).toBe("http://oak.lan:8080/#invite=sec");
    expect(buildInviteLink("http://oak.lan:8080///", "sec")).toBe("http://oak.lan:8080/#invite=sec");
  });

  it("round-trips with parseInviteLink", () => {
    const parsed = parseInviteLink(buildInviteLink("http://oak.lan:9000", "abc_DEF-123"));
    expect(parsed).toEqual({ origin: "http://oak.lan:9000", secret: "abc_DEF-123" });
  });
});

describe("formatExpiresIn", () => {
  it("labels minutes only in the last hour", () => {
    expect(formatExpiresIn(minutesFromNow(45), NOW)).toBe("45m");
    expect(formatExpiresIn(minutesFromNow(1), NOW)).toBe("1m");
  });

  it("labels whole hours without minutes", () => {
    expect(formatExpiresIn(minutesFromNow(3 * 60 + 12), NOW)).toBe("3h");
    expect(formatExpiresIn(minutesFromNow(2 * 60), NOW)).toBe("2h");
  });

  it("labels days with leftover hours", () => {
    expect(formatExpiresIn(minutesFromNow((2 * 24 + 5) * 60), NOW)).toBe("2d 5h");
    expect(formatExpiresIn(minutesFromNow(3 * 24 * 60), NOW)).toBe("3d");
  });

  it("reports the boundary and the past as expired", () => {
    expect(formatExpiresIn(minutesFromNow(0), NOW)).toBe("expired");
    expect(formatExpiresIn(minutesFromNow(-30), NOW)).toBe("expired");
    expect(formatExpiresIn("not-a-date", NOW)).toBe("expired");
  });
});

describe("formatTtlWords", () => {
  it("renders single non-zero segments", () => {
    expect(formatTtlWords(1)).toBe("1 min");
    expect(formatTtlWords(45)).toBe("45 min");
    expect(formatTtlWords(60)).toBe("1 h");
    expect(formatTtlWords(1440)).toBe("1 d");
    expect(formatTtlWords(43200)).toBe("30 d");
  });

  it("combines only the non-zero segments, largest first", () => {
    expect(formatTtlWords(90)).toBe("1 h 30 min");
    expect(formatTtlWords(1500)).toBe("1 d 1 h"); // 25 hours, no minutes
    expect(formatTtlWords(4470)).toBe("3 d 2 h 30 min");
    expect(formatTtlWords(74565)).toBe("51 d 18 h 45 min");
  });

  it("renders the one-year cap as flat 365 days", () => {
    expect(formatTtlWords(525600)).toBe("365 d");
  });

  it("renders zero, negatives and garbage as 0 min", () => {
    expect(formatTtlWords(0)).toBe("0 min");
    expect(formatTtlWords(-5)).toBe("0 min");
    expect(formatTtlWords(Number.NaN)).toBe("0 min");
    expect(formatTtlWords(Number.POSITIVE_INFINITY)).toBe("0 min");
  });
});
