import { describe, expect, it } from "vitest";
import { buildEnvFile, generateEnvSecrets } from "../src/domain/provisioning/env-file";
import {
  isValidProvisioningHost,
  provisionedHostUrl,
  validateProvisioningParams,
  type ProvisioningParams,
} from "../src/domain/provisioning/params";
import {
  caddyFileForMode,
  composeImageRefs,
  extractJsonObject,
  parseCurlWithStatus,
  parseOpensslFingerprint,
  selfSignedSan,
} from "../src/domain/provisioning/artifacts";

describe("provisioning params validation", () => {
  it("accepts IPs, hostnames and localhost", () => {
    expect(isValidProvisioningHost("203.0.113.10")).toBe(true);
    expect(isValidProvisioningHost("oak.example.com")).toBe(true);
    expect(isValidProvisioningHost("localhost")).toBe(true);
    expect(isValidProvisioningHost("2001:db8::1")).toBe(true);
  });

  it("rejects shell metacharacters — the host lands inside shell commands", () => {
    expect(isValidProvisioningHost("host; rm -rf /")).toBe(false);
    expect(isValidProvisioningHost("host'$(id)'")).toBe(false);
    expect(isValidProvisioningHost("host with spaces")).toBe(false);
    expect(isValidProvisioningHost("host|id")).toBe(false);
    expect(isValidProvisioningHost("")).toBe(false);
    expect(isValidProvisioningHost("   ")).toBe(false);
  });

  it("validates the full form", () => {
    const params: ProvisioningParams = {
      host: "203.0.113.10",
      sshPort: 22,
      sshLogin: "root",
      sshPassword: "pw",
      sshKeyPath: null,
      sshKeyPassphrase: null,
      domain: null,
      firewall: true,
      adminLogin: "admin",
      adminNickname: null,
      adminPassword: "longenough",
      jarPath: null,
    };
    expect(validateProvisioningParams(params)).toBeNull();
    expect(validateProvisioningParams({ ...params, host: "bad host" })).toContain("address");
    expect(validateProvisioningParams({ ...params, sshPort: 0 })).toContain("port");
    expect(validateProvisioningParams({ ...params, sshLogin: "  " })).toContain("SSH user");
    expect(validateProvisioningParams({ ...params, sshPassword: null })).toContain("password");
    // An ENCRYPTED key is a complete auth: key path + passphrase passes, and a
    // passphrase alone (no key, no password) is not an auth at all.
    expect(validateProvisioningParams({
      ...params,
      sshPassword: null,
      sshKeyPath: "C:\\keys\\id_ed25519",
      sshKeyPassphrase: "open sesame",
    })).toBeNull();
    expect(validateProvisioningParams({
      ...params,
      sshPassword: null,
      sshKeyPath: null,
      sshKeyPassphrase: "open sesame",
    })).toContain("password");
    expect(validateProvisioningParams({ ...params, domain: "not a domain" })).toContain("domain");
    expect(validateProvisioningParams({ ...params, adminPassword: "short" })).toContain("8 characters");
    // The Space account grammars: ASCII login, unicode no-space nickname.
    expect(validateProvisioningParams({ ...params, adminLogin: "ab" })).toContain("login");
    expect(validateProvisioningParams({ ...params, adminLogin: "not ok!" })).toContain("login");
    expect(validateProvisioningParams({ ...params, adminNickname: "Вася" })).toBeNull();
    expect(validateProvisioningParams({ ...params, adminNickname: "a b" })).toContain("nickname");
  });

  it("prefers the domain in the resulting host URL", () => {
    const params: ProvisioningParams = {
      host: "203.0.113.10",
      sshPort: 22,
      sshLogin: "root",
      sshPassword: "pw",
      sshKeyPath: null,
      sshKeyPassphrase: null,
      domain: "oak.example.com",
      firewall: false,
      adminLogin: "admin",
      adminNickname: null,
      adminPassword: "longenough",
      jarPath: null,
    };
    expect(provisionedHostUrl(params)).toBe("https://oak.example.com");
    expect(provisionedHostUrl({ ...params, domain: null })).toBe("https://203.0.113.10");
  });
});

describe("env file generation", () => {
  it("seeds every secret from the random source", () => {
    const secrets = generateEnvSecrets((bytes) => `${bytes}`.repeat(bytes).slice(0, bytes * 2));
    expect(secrets.jwtSecret).toHaveLength(64);
    expect(secrets.postgresPassword).toHaveLength(32);
  });

  it("writes per-deployment secrets and the public addresses", () => {
    const file = buildEnvFile("oak.example.com", "203.0.113.10", {
      postgresPassword: "pg",
      minioRootPassword: "mr",
      minioAppPassword: "ma",
      jwtSecret: "jwt",
      janusAdminSecret: "janus",
      turnStaticAuthSecret: "turn",
    });
    expect(file).toContain("POSTGRES_PASSWORD=pg");
    expect(file).toContain("MINIO_APP_PASSWORD=ma");
    expect(file).toContain("JWT_SECRET=jwt");
    expect(file).toContain("JANUS_ADMIN_SECRET=janus");
    expect(file).toContain("TURN_STATIC_AUTH_SECRET=turn");
    expect(file).toContain("TURN_EXTERNAL_IP=203.0.113.10");
    expect(file).toContain("OAK_PUBLIC_HOST=oak.example.com");
    expect(file).toContain("OAK_SITE_ADDRESS=https://oak.example.com");
    expect(file).toContain("OAK_MINIO_SITE_ADDRESS=https://oak.example.com:9443");
    // The dev template's placeholders must never slip through.
    expect(file).not.toContain("change-me");
  });
});

describe("provisioning artifacts", () => {
  const template = "{\n\tadmin off\n\tdefault_sni {$OAK_PUBLIC_HOST}\n}\nsite {\n\ttls a b # provisioning:tls-file\n\thandle\n}\nminio {\n\ttls a b # provisioning:tls-file\n}\n";

  it("keeps the tls lines for a self-signed deployment", () => {
    expect(caddyFileForMode(template, false)).toBe(template);
  });

  it("strips ONLY the marked tls lines for ACME", () => {
    const acme = caddyFileForMode(template, true);
    expect(acme).not.toContain("provisioning:tls-file");
    expect(acme).toContain("site {");
    expect(acme).toContain("minio {");
    expect(acme).toContain("handle");
    // The no-SNI fallback survives the ACME rewrite (bare-IP clients still
    // need it after a future domain move).
    expect(acme).toContain("default_sni");
  });

  it("builds the SAN with IP: for literals and DNS: for names", () => {
    expect(selfSignedSan("203.0.113.10")).toBe("subjectAltName=DNS:localhost,IP:127.0.0.1,IP:203.0.113.10");
    expect(selfSignedSan("2001:db8::1")).toBe("subjectAltName=DNS:localhost,IP:127.0.0.1,IP:2001:db8::1");
    expect(selfSignedSan("oak.example.com")).toBe("subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:oak.example.com");
  });

  it("parses openssl fingerprints into the normalized pin", () => {
    const full = "AB".repeat(32); // a full SHA-256 digest
    expect(parseOpensslFingerprint(`sha256 Fingerprint=${full.match(/.{2}/g)!.join(":")}\n`)).toBe(full);
    // Line-wrapped output still parses.
    expect(parseOpensslFingerprint("sha256 Fingerprint=AA:BB:\nCC\n")).toBeNull(); // not 64 chars
    expect(parseOpensslFingerprint("garbage")).toBeNull();
    expect(parseOpensslFingerprint("sha256 Fingerprint=AA")).toBeNull();
  });

  it("splits curl status-marker output", () => {
    expect(parseCurlWithStatus(`{"token":"t"}\n__STATUS__201`)).toEqual({ status: 201, body: `{"token":"t"}` });
    expect(parseCurlWithStatus("no marker")).toBeNull();
    expect(parseCurlWithStatus("body\n__STATUS__abc")).toBeNull();
  });

  it("extracts the first balanced JSON object from noisy output", () => {
    expect(extractJsonObject(`warning: stuff\n{"token":"a{b}c"}\n__STATUS__201`))
      .toEqual({ token: "a{b}c" });
    expect(extractJsonObject("no json")).toBeNull();
    expect(extractJsonObject(`{"unterminated": true`)).toBeNull();
  });

  it("collects the pullable image refs out of a compose file", () => {
    const compose = [
      "services:",
      "  postgres:",
      "    image: postgres:16-alpine",
      "  oak:",
      "    build: .",
      "    image: oak-server:local",
      "  janus:",
      "    build: ./janus",
      "    image: oak-janus:secured",
      "  weird:",
      "    image: ${SOME_IMAGE}",
    ].join("\n");
    expect(composeImageRefs(compose)).toEqual(["postgres:16-alpine"]);
  });
});
