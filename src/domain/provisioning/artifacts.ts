/**
 * Small pure transformations over the provisioning file templates
 * (electron/provisioning/files/*) and over openssl output: the Caddyfile's
 * TLS-mode switch, the self-signed certificate's SAN list, and the SHA-256
 * fingerprint parsing that feeds the client's TOFU pin.
 */
import { normalizeCertFingerprint } from "../logic/cert-pin";

/**
 * The Caddyfile template pins its certificate to FILES (self-signed; marked
 * lines end with "# provisioning:tls-file"). A DOMAIN deployment strips every
 * marked line — Caddy then runs ACME/Let's Encrypt automatically. Everything
 * else is byte-identical between the modes.
 */
export function caddyFileForMode(template: string, domainDeployment: boolean): string {
  if (!domainDeployment) {
    return template;
  }
  return template
    .split("\n")
    .filter((line) => !line.includes("# provisioning:tls-file"))
    .join("\n");
}

/** The subjectAltName list for the self-signed certificate: localhost always,
 *  plus the public address (IP: for literals, DNS: for names). Single-quoted
 *  by the caller; the values are pre-validated to the shell-safe charset. */
export function selfSignedSan(host: string): string {
  const entry = host.includes(":") && !host.includes(".")
    ? `IP:${host}`
    : /^[0-9.]+$/.test(host)
      ? `IP:${host}`
      : `DNS:${host}`;
  return `subjectAltName=DNS:localhost,IP:127.0.0.1,${entry}`;
}

/** Parses `openssl x509 -fingerprint -sha256` output ("sha256 Fingerprint=AA:BB:…"
 *  possibly wrapped over lines) into the normalized hex pin; null on garbage. */
export function parseOpensslFingerprint(opensslOutput: string): string | null {
  const joined = opensslOutput.replace(/\s+/g, " ");
  const match = /Fingerprint=([0-9A-Fa-f:]+)/.exec(joined);
  if (match === null) {
    return null;
  }
  const normalized = normalizeCertFingerprint(match[1]!);
  // SHA-256 = 64 hex chars; anything else is not a fingerprint we asked for.
  return normalized.length === 64 ? normalized : null;
}

/** Extracts a JSON object out of curl output (the REST endpoint answers JSON;
 *  stray warnings may share the stream — take the first balanced object). */
export function extractJsonObject(stdout: string): unknown | null {  const start = stdout.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Splits curl output shaped by `-w '\n__STATUS__%{http_code}'` into the body
 *  and the numeric status; null when the marker never arrived (transport
 *  failure, not an HTTP answer). */
export function parseCurlWithStatus(stdout: string): { status: number; body: string } | null {
  const markerIndex = stdout.lastIndexOf("\n__STATUS__");
  if (markerIndex === -1) {
    return null;
  }
  const status = Number(stdout.slice(markerIndex + "\n__STATUS__".length).trim());
  if (!Number.isInteger(status) || status <= 0) {
    return null;
  }
  return { status, body: stdout.slice(0, markerIndex) };
}

/** The server-kit release asset URLs, pinned to the TAG equal to the client's
 *  version (user decision 2026-10-29): parity beats availability — the latest
 *  release shortcut can hand out a server the client was NOT built against,
 *  while a missing tag is an honest, immediate failure. The archive names are
 *  the FLAT manifest.json names (the publishing script owns them — rule D1:
 *  the consumer adapts). */
export function serverJarUrl(appVersion: string): string {
  return `https://github.com/medius-x/oak-server/releases/download/v${appVersion}/oak-server.jar`;
}

export function serverKitAssetUrl(appVersion: string, archive: string): string {
  return `https://github.com/medius-x/oak-server/releases/download/v${appVersion}/${archive}`;
}

/** The build's kit: "full" bundles the server kit (jar + image archives) in
 *  extraResources; "light" ships only the templates and the digest manifest —
 *  everything big is fetched at provisioning time. */
export type ProvisioningKit = "light" | "full";

/** Parses the kit marker (resources/provisioning/files/kit.json). A missing
 *  or garbage marker reads as "full": pre-0.4.0 installs and dev trees carry
 *  no marker, and their behaviour must not change. */
export function parseKitMarker(content: string | null): ProvisioningKit {
  if (content === null) {
    return "full";
  }
  try {
    const parsed = JSON.parse(content) as { kit?: unknown };
    return parsed?.kit === "light" ? "light" : "full";
  } catch {
    return "full";
  }
}

/** One digest-pinned image of the server kit. */
export interface ImageManifestEntry {
  /** The pullable digest reference (repo@sha256:…). */
  ref: string;
  /** The FLAT GitHub asset name (postgres.tar.gz) — also the archive file name. */
  archive: string;
  /** The expected archive size in bytes (progress + stale-remainder checks). */
  bytes: number;
}

/** Parses manifest.json into the valid entries (invalid records drop out
 *  silently — a half-written manifest must not fail the whole ladder). This
 *  is the ALWAYS-present pin source for BOTH kits: the light build strips the
 *  tarballs but keeps the manifest. Null when there is nothing usable. */
export function parseImageManifest(content: string | null): ImageManifestEntry[] | null {
  if (content === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const entries = parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      const record = entry as { ref?: unknown; archive?: unknown; bytes?: unknown };
      return typeof record.ref === "string" && typeof record.archive === "string" && typeof record.bytes === "number"
        ? [{ ref: record.ref, archive: record.archive, bytes: record.bytes }]
        : [];
    });
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** The pullable image references of a compose file: every `image:` line that
 *  is NOT env-interpolated and NOT a locally built tag (the oak/janus build
 *  services carry image: only as their local tag). Used when no bundled
 *  manifest exists — the per-image pull ladder needs the explicit list. */
export function composeImageRefs(composeFile: string): string[] {
  const refs = new Set<string>();
  for (const match of composeFile.matchAll(/^\s*image:\s*(\S+)\s*$/gm)) {
    const ref = match[1]!;
    if (ref.includes("${")) {
      continue;
    }
    if (ref.endsWith(":local") || ref.endsWith(":secured")) {
      continue;
    }
    refs.add(ref);
  }
  return [...refs];
}
