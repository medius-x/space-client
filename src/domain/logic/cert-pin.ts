/**
 * Self-signed-certificate pinning (TLS entry point, provisioning round B).
 *
 * Deployments behind the Caddy entry point with a BARE-IP host cannot obtain a
 * CA-signed certificate — the client instead TRUSTS ON FIRST USE: the user
 * confirms the certificate's SHA-256 fingerprint once, it is pinned to the
 * server record, and every later connection compares against the pin (a change
 * is a possible MITM and blocks loudly). The Electron main process owns the
 * decision; these pure helpers keep it testable.
 */

/**
 * Electron's `certificate.fingerprint256` is the SHA-256 of the DER certificate
 * as UPPERCASE hex with colon separators ("AB:CD:…", 95 chars). The pin is
 * stored colon-free uppercase — one canonical form, tolerant of any separator
 * spacing a future Electron might change.
 */
export function normalizeCertFingerprint(fingerprint256: string): string {
  return fingerprint256.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/** True when both values are the SAME certificate after normalization. */
export function certFingerprintsMatch(pinned: string, presented: string): boolean {
  return pinned !== "" && normalizeCertFingerprint(pinned) === normalizeCertFingerprint(presented);
}

/** The canonical hex back in readable "AA:BB:CC…" form for dialog display. */
export function formatCertFingerprint(normalized: string): string {
  return normalized.replace(/(..)(?=.)/g, "$1:");
}

/** The hostname of a URL, or null for anything unparseable (fail closed). */
export function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
