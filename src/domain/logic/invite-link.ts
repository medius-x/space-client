/**
 * Invite-link assembly and parsing — the client half of the invite registration. The
 * server assembles the canonical form {@code http://host:port/#invite=<secret>} (the
 * secret rides the hash fragment); the Register tab parses a pasted link back into the
 * server origin (which auto-fills the address field) plus the secret submitted in the
 * register body. Parsing is lenient on PURPOSE: the user hand-pastes the link, so
 * {@code ?invite=} is tolerated alongside the canonical hash, a missing scheme is
 * assumed {@code http://}, and surrounding whitespace never breaks a valid link.
 */

export interface ParsedInviteLink {
  /** The server origin ({@code scheme://host[:port]}), no trailing slash — the address field value. */
  origin: string;
  /** The single-use registration secret from the link. */
  secret: string;
}

/** Extracts the secret from a URL's hash fragment ({@code #invite=abc}), before any {@code &}. */
function secretFromHash(hash: string): string | null {
  const fragment = hash.replace(/^#/, "");
  if (!fragment.startsWith("invite=")) {
    return null;
  }
  const value = fragment.slice("invite=".length).split("&", 1)[0] ?? "";
  return value.length > 0 ? value : null;
}

/**
 * Parses an invite link. Returns null for anything that does not carry a non-empty
 * {@code invite} secret in the hash or the query — a plain server URL, free text, an
 * empty fragment. The origin comes from {@code URL.origin}, which normalizes trailing
 * slashes and keeps IPv6 brackets intact.
 */
export function parseInviteLink(value: string): ParsedInviteLink | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // A pasted "host:8080/#invite=…" has no scheme; URL would treat "host:" as the protocol.
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const secret = secretFromHash(url.hash) ?? url.searchParams.get("invite");
  if (secret === null || secret.length === 0) {
    return null;
  }
  return { origin: url.origin, secret };
}

/** Builds the canonical link form — the mirror of the server's InviteController.buildLink. */
export function buildInviteLink(origin: string, secret: string): string {
  return `${origin.replace(/\/+$/, "")}/#invite=${secret}`;
}

/**
 * A short relative label for the invites list: days + hours, and plain minutes in the
 * LAST hour before expiry ("2d 5h", "3h", "45m"); "expired" at or past the moment.
 * {@code now} is a parameter (not Date.now() inside) so the pure function stays testable.
 */
export function formatExpiresIn(expiresAt: string, now: number): string {
  const remainingMillis = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMillis) || remainingMillis <= 0) {
    return "expired";
  }
  const remainingMinutes = Math.floor(remainingMillis / 60_000);
  const days = Math.floor(remainingMinutes / (60 * 24));
  const hours = Math.floor((remainingMinutes % (60 * 24)) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

const TTL_DAY_MINUTES = 24 * 60;
const TTL_HOUR_MINUTES = 60;

/**
 * Renders a TTL given in MINUTES as the human words under the input field:
 * "5 d 3 h 4 min" — days, hours and minutes only (no months; the field's cap is a flat
 * 365 days = 525600 minutes = "365 d"). Only the non-zero segments, largest first.
 * Zero renders "0 min" (the input's own validation rejects it before a save).
 */
export function formatTtlWords(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    return "0 min";
  }
  const days = Math.floor(totalMinutes / TTL_DAY_MINUTES);
  const hours = Math.floor((totalMinutes % TTL_DAY_MINUTES) / TTL_HOUR_MINUTES);
  const minutes = Math.floor(totalMinutes % TTL_HOUR_MINUTES);
  const segments: string[] = [];
  if (days > 0) {
    segments.push(`${days} d`);
  }
  if (hours > 0) {
    segments.push(`${hours} h`);
  }
  if (minutes > 0) {
    segments.push(`${minutes} min`);
  }
  return segments.length > 0 ? segments.join(" ") : "0 min";
}
