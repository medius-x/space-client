import { describe, expect, it } from "vitest";
import { isBlockedAddress, PREVIEW_REDIRECT_LIMIT, previewUrlFromString } from "../src/domain/logic/net-guard";

/** M5: the address half of the preview-fetch SSRF guard — every private/loopback/
 *  link-local form blocks (v4, v6, mapped v6, brackets, zone ids), public space
 *  passes, and unparseable input fails CLOSED. */
describe("isBlockedAddress", () => {
  it("blocks the v4 special ranges", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.5",
      "100.64.0.1", // CGNAT
      "100.127.255.255",
      "127.0.0.1",
      "127.8.8.8", // the whole 127/8, not just .1
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.5",
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255",
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("passes public v4 space", () => {
    const allowed = ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "93.184.216.34"];
    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("blocks the v6 special ranges", () => {
    const blocked = [
      "::",
      "::1",
      "fe80::1",
      "fe80::1%12", // zone id stripped
      "febf::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "ff02::1",
      "::ffff:127.0.0.1", // v4-mapped loopback
      "::ffff:192.168.0.1",
      "[::1]", // bracketed URL form
      "[::ffff:10.0.0.1]",
      "::10.0.0.1", // deprecated v4-compatible
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("passes public v6 space", () => {
    const allowed = [
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8", // a mapped PUBLIC address is still public
      "2a00:1450:4001:81b::200e",
    ];
    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("fails closed on unparseable input", () => {
    for (const garbage of ["", "not-an-ip", "999.1.1.1", "10.0.0", "10.0.0.1.2", "fe80:::1", "1:2:3"]) {
      expect(isBlockedAddress(garbage), JSON.stringify(garbage)).toBe(true);
    }
  });
});

describe("previewUrlFromString", () => {
  it("accepts http and https, rejects other schemes and garbage", () => {
    expect(previewUrlFromString("http://example.com/page")?.hostname).toBe("example.com");
    expect(previewUrlFromString("https://example.com:8443/x")?.port).toBe("8443");
    expect(previewUrlFromString("file:///etc/passwd")).toBeNull();
    expect(previewUrlFromString("ftp://example.com")).toBeNull();
    expect(previewUrlFromString("not a url")).toBeNull();
  });

  it("keeps the redirect limit bounded", () => {
    expect(PREVIEW_REDIRECT_LIMIT).toBeGreaterThan(0);
    expect(PREVIEW_REDIRECT_LIMIT).toBeLessThanOrEqual(5);
  });
});
