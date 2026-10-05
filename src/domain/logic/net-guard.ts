/**
 * M5 (security round 7): the pure half of the SSRF guard for the main-process
 * link-preview fetch (`space-net:fetch`). The renderer can ask main to fetch ANY
 * http(s) URL — without an address check that is a free proxy into the machine's
 * own network (localhost services, router panels, cloud metadata endpoints).
 *
 * `isBlockedAddress` decides for a single RESOLVED address (the caller DNS-resolves
 * first and blocks when ANY result is blocked — a multi-A-record name must not slip
 * through on its second answer). Unparseable input blocks: the guard fails closed.
 *
 * Blocked space (the mainstream SSRF set, v4 + v6):
 *   0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12,
 *   192.168/16, 224+/4 (multicast + reserved) — and ::, ::1, fc00::/7,
 *   fe80::/10, ff00::/8, plus the IPv4-mapped/compatible v6 forms which defer to
 *   the v4 rules.
 */

/** How many redirects the preview fetch may follow (each one re-checked). */
export const PREVIEW_REDIRECT_LIMIT = 4;

/** A URL the preview fetch may talk to at all: http(s) only, well-formed. The
 *  HOSTNAME's address space is the caller's DNS concern. null when unusable. */
export function previewUrlFromString(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Whether a resolved/literal address sits in space the preview fetch must never
 *  reach. Brackets ("[::1]") and a v6 zone id ("fe80::1%12") are tolerated. */
export function isBlockedAddress(rawAddress: string): boolean {
  const address = rawAddress.trim().replace(/^\[/, "").replace(/\]$/, "").split("%")[0]!.toLowerCase();
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4);
  }
  const groups = parseIpv6(address);
  if (groups === null) {
    return true; // fail closed — DNS answers are well-formed, so this is something odd
  }
  return isBlockedIpv6(groups);
}

function isBlockedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) {
    return true; // "this network", private, loopback
  }
  if (first === 169 && second === 254) {
    return true; // link-local (cloud metadata lives here)
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true; // private
  }
  if (first === 192 && second === 168) {
    return true; // private
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true; // CGNAT shared
  }
  if (first >= 224) {
    return true; // multicast + reserved, broadcast included
  }
  return false;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  if (groups.every((group) => group === 0)) {
    return true; // :: (unspecified)
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true; // ::1
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if ((first & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((first & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  // ::ffff:a.b.c.d (mapped — five zero groups then 0xffff) and ::a.b.c.d
  // (deprecated compatible — six zero groups): the low 32 bits defer to the v4
  // rules. The earlier rules have already consumed :: and ::1.
  const embedded = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff] as const;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4(embedded);
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return isBlockedIpv4(embedded);
  }
  return false;
}

/** Strict dotted-quad parse; null for anything else. */
function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Full IPv6 parse into 8 groups; null when malformed. Understands "::"
 *  compression and an embedded IPv4 tail. */
function parseIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = parseIpv6Groups(halves[0]!);
  if (head === null) {
    return null;
  }
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1]!) : null;
  if (tail === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 1) {
    return null; // "::" must stand for at least one zero group
  }
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/** Groups of one "::"-free half; "" parses as zero groups. */
function parseIpv6Groups(part: string): number[] | null {
  if (part === "") {
    return [];
  }
  const segments = part.split(":");
  const groups: number[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(segment)) {
      if (index !== segments.length - 1) {
        return null; // an embedded IPv4 is only legal as the last segment
      }
      const embedded = parseIpv4(segment);
      if (embedded === null) {
        return null;
      }
      groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
    } else if (/^[0-9a-f]{1,4}$/.test(segment)) {
      groups.push(Number.parseInt(segment, 16));
    } else {
      return null;
    }
  }
  return groups;
}
