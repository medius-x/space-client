import { describe, expect, it } from "vitest";
import {
  certFingerprintsMatch,
  formatCertFingerprint,
  hostnameFromUrl,
  normalizeCertFingerprint,
} from "../src/domain/logic/cert-pin";

/**
 * Pure helpers of the TOFU certificate pin (TLS entry point, round B): Electron
 * hands fingerprint256 as colon-separated uppercase hex; the pin stores one
 * canonical colon-free form and compares through normalization.
 */

const PRETTY = "AB:CD:EF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D";

describe("normalizeCertFingerprint", () => {
  it("strips colons and uppercases", () => {
    expect(normalizeCertFingerprint(PRETTY)).toBe(PRETTY.replace(/:/g, ""));
  });

  it("is idempotent for the stored canonical form and tolerant of lowercase input", () => {
    const normalized = normalizeCertFingerprint(PRETTY);
    expect(normalizeCertFingerprint(normalized)).toBe(normalized);
    expect(normalizeCertFingerprint(PRETTY.toLowerCase())).toBe(normalized);
  });

  it("drops non-hex noise entirely", () => {
    expect(normalizeCertFingerprint("ab-cd ef")).toBe("ABCDEF");
  });
});

describe("certFingerprintsMatch", () => {
  it("matches the same certificate in any notation", () => {
    expect(certFingerprintsMatch(PRETTY, PRETTY.toLowerCase())).toBe(true);
    expect(certFingerprintsMatch(normalizeCertFingerprint(PRETTY), PRETTY)).toBe(true);
  });

  it("rejects different certificates and never matches empties", () => {
    expect(certFingerprintsMatch(PRETTY, PRETTY.replace("AB:", "BA:"))).toBe(false);
    expect(certFingerprintsMatch("", PRETTY)).toBe(false);
    expect(certFingerprintsMatch(PRETTY, "")).toBe(false);
  });
});

describe("formatCertFingerprint", () => {
  it("renders the canonical form back with colon separators", () => {
    expect(formatCertFingerprint(PRETTY.replace(/:/g, ""))).toBe(PRETTY);
  });
});

describe("hostnameFromUrl", () => {
  it("extracts https and wss hostnames (the STOMP upgrade reports wss)", () => {
    expect(hostnameFromUrl("https://203.0.113.10/api/server")).toBe("203.0.113.10");
    expect(hostnameFromUrl("wss://203.0.113.10:443/ws")).toBe("203.0.113.10");
    expect(hostnameFromUrl("https://localhost:9443/oak-attachments/x")).toBe("localhost");
  });

  it("keeps IPv6 hosts bracketed — consistently on both sides of the comparison", () => {
    // Node's URL.hostname KEEPS the brackets; every pin lookup parses through
    // this same helper, so the match stays exact across ports.
    expect(hostnameFromUrl("https://[2001:db8::1]:443/api")).toBe("[2001:db8::1]");
    expect(hostnameFromUrl("https://[2001:db8::1]:9443/x")).toBe("[2001:db8::1]");
  });

  it("fails closed on garbage", () => {
    expect(hostnameFromUrl("not a url")).toBeNull();
    expect(hostnameFromUrl("")).toBeNull();
  });
});
