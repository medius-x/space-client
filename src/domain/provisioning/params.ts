/**
 * Provisioning form parameters and their validation (round C). The host and
 * domain are the ONLY caller-supplied strings that ever land inside shell
 * commands and the .env file — the validation below is therefore a SECURITY
 * boundary, not just UX: the charset excludes every shell metacharacter, so an
 * interpolated value can never break out of its quoting.
 */

export interface ProvisioningParams {
  /** The server's reachable address — a bare IPv4/IPv6 literal or a hostname
   *  (what the user types; also becomes TURN_EXTERNAL_IP/OAK_PUBLIC_HOST). */
  host: string;
  /** SSH port (defaults to 22 in the form; always a number here). */
  sshPort: number;
  /** SSH login (Ubuntu images commonly ship "root" or "ubuntu"). */
  sshLogin: string;
  /** SSH password — null when a key file is used instead. */
  sshPassword: string | null;
  /** Path to an SSH private key on THIS machine (optional). */
  sshKeyPath: string | null;
  /** Passphrase of that key — null/empty for an unencrypted key. An encrypted
   *  OpenSSH key without it fails the connect step with "no passphrase given"
   *  (live log 2026-10-16), so the form carries the field (user report #2). */
  sshKeyPassphrase: string | null;
  /** A domain pointing at the host — switches TLS to Let's Encrypt. Null =
   *  self-signed certificate + client TOFU pin. */
  domain: string | null;
  /** Configure ufw (allow 22/443/9443/TURN/media, deny the rest). */
  firewall: boolean;
  /** The Space account the flow registers as the server's OWNER (the form
   *  defaults empty fields to admin/admin/password). The nickname is optional
   *  — null lets the server default it to the login. */
  adminLogin: string;
  adminNickname: string | null;
  /** 8+ chars — the server's register validation enforces it. */
  adminPassword: string;
  /** Local path to the oak-server jar. Null = the bundled jar / the latest
   *  GitHub release artifact (the source ladder). */
  jarPath: string | null;
}

/** The one-password defaults the Create form falls back to (user decision,
 *  2026-10-12): login/nickname "admin", password "password". */
export const DEFAULT_ACCOUNT_LOGIN = "admin";
export const DEFAULT_ACCOUNT_PASSWORD = "password";

/** Hostname/IP charset: letters, digits, dots, hyphens, colons (IPv6). This is
 *  the security whitelist — see the file header before widening it. */
const HOST_CHARSET = /^[A-Za-z0-9.:-]+$/;

export function isValidProvisioningHost(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed === "" || trimmed.length > 253 || !HOST_CHARSET.test(trimmed)) {
    return false;
  }
  // A hostname must contain at least one dot (or be an IP literal / "localhost"
  // — a single label is never routable in practice).
  return trimmed.includes(".") || trimmed === "localhost" || trimmed.includes(":");
}

/** Field-by-field validation; null = the form may proceed. */
export function validateProvisioningParams(params: ProvisioningParams): string | null {
  if (!isValidProvisioningHost(params.host)) {
    return "Server address must be an IP or a host name (letters, digits, dots, hyphens).";
  }
  if (!Number.isInteger(params.sshPort) || params.sshPort < 1 || params.sshPort > 65535) {
    return "SSH port must be a number between 1 and 65535.";
  }
  if (params.sshLogin.trim().length === 0) {
    return "SSH user must not be empty.";
  }
  const hasKey = params.sshKeyPath !== null && params.sshKeyPath.trim().length > 0;
  const hasPassword = params.sshPassword !== null && params.sshPassword.length > 0;
  if (!hasKey && !hasPassword) {
    return "Provide the SSH password or a path to a private key.";
  }
  if (params.domain !== null && !isValidProvisioningHost(params.domain)) {
    return "The domain must be a valid host name.";
  }
  // The Space account: login mirrors the server's username grammar, nickname
  // its unicode no-space grammar, password the 8+ minimum.
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(params.adminLogin)) {
    return "Space account login must be 3-32 characters of letters, digits, _ and -.";
  }
  if (params.adminNickname !== null && !/^[\p{L}\p{N}_-]{1,32}$/u.test(params.adminNickname)) {
    return "Space account nickname must be 1-32 characters without spaces.";
  }
  if (params.adminPassword.length < 8) {
    return "Space account password must be at least 8 characters.";
  }
  return null;
}

/** The address clients will connect through after the deployment: a domain
 *  rides Let's Encrypt on the default port, a bare IP gets the self-signed
 *  TOFU certificate — both are plain https origins. */
export function provisionedHostUrl(params: ProvisioningParams): string {
  return `https://${(params.domain ?? params.host).trim()}`;
}

/** Is the host an IPv6 literal (needs brackets in URLs)? Not used for shell
 *  commands — only where the value is embedded in an openssl SAN. */
export function isIpv6Literal(host: string): boolean {
  return host.includes(":") && !host.includes(".");
}
