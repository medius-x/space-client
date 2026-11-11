/**
 * The per-host SSH access catalog (backlog feature 2, 2026-11-11): the
 * passphrase-ENCRYPTED private key a hardening run installed on a server,
 * with its public half and the login/port it belongs to. Keyed by the
 * NORMALIZED server origin (not the Space connection record — a provisioning
 * run may legitimately finish before any account login exists), so repeat
 * runs offer key-based SSH without the user re-picking anything.
 *
 * The passphrase itself is NEVER stored: the private key is an OpenSSH
 * bcrypt-encrypted blob, useless without the user typing the phrase.
 */
import { kv } from "../persistence/kv-client";

export interface SshAccess {
  /** The one-line OpenSSH public key (ssh-ed25519 …). */
  publicKey: string;
  /** The OpenSSH PEM private key, passphrase-encrypted at generation. */
  privateKey: string;
  login: string;
  port: number;
  /** Epoch ms of the run that installed this key. */
  addedAt: number;
}

const KEY_PREFIX = "ssh-access:";

/** The catalog's canonical host form: scheme and path stripped, lowercased —
 *  the provisioning form types a bare address while a session knows the full
 *  origin, and both must land on the SAME catalog entry. */
export function normalizeAccessHost(hostUrl: string): string {
  return hostUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

/** Hand-edited KV garbage reads as "no stored access" — never crashes a form. */
export function sanitizeSshAccess(raw: unknown): SshAccess | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const publicKey = typeof record.publicKey === "string" ? record.publicKey.trim() : "";
  const privateKey = typeof record.privateKey === "string" ? record.privateKey : "";
  const login = typeof record.login === "string" ? record.login.trim() : "";
  const port = typeof record.port === "number" && Number.isInteger(record.port) && portInRange(record.port) ? record.port : 22;
  const addedAt = typeof record.addedAt === "number" && Number.isFinite(record.addedAt) ? record.addedAt : 0;
  if (!publicKey.startsWith("ssh-ed25519 ") || !privateKey.includes("BEGIN OPENSSH PRIVATE KEY") || login.length === 0) {
    return null;
  }
  return { publicKey, privateKey, login, port, addedAt };
}

function portInRange(port: number): boolean {
  return port > 0 && port < 65536;
}

export async function loadSshAccess(hostUrl: string): Promise<SshAccess | null> {
  return sanitizeSshAccess(await kv.get<unknown>(KEY_PREFIX + normalizeAccessHost(hostUrl)));
}

export async function saveSshAccess(hostUrl: string, access: SshAccess): Promise<void> {
  await kv.set(KEY_PREFIX + normalizeAccessHost(hostUrl), access);
}
