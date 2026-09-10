import type { Role, ServerMember } from "../../types";

/**
 * Pure roster grouping math (oak's rebuildMemberNodes rules):
 *  - online members whose HIGHEST hoist-role (hoist=true, kind != OWNER) bucket
 *    under that role, group order = role position DESC;
 *  - the OWNER member always sits in the plain Online bucket (oak parity);
 *  - remaining online members under "Online — N", offline under "Offline — M"
 *    (hoist does NOT apply offline);
 *  - inside a group: self first, then username alphabetical.
 *
 * The server ships raw roleIds + roles only — effective color and hoist priority
 * are the CLIENT's job (there is no computed field on the wire).
 */

export interface RosterEntry {
  member: ServerMember;
  /** Nick color from the highest-position role that HAS a color; null = default. */
  nameColor: string | null;
  online: boolean;
  isSelf: boolean;
}

export interface RosterGroup {
  key: string;
  title: string;
  /** Hoist-role color for the header; null = default gray. */
  titleColor: string | null;
  entries: RosterEntry[];
}

/** Java int ARGB (negative values are normal) → a CSS rgb() string. */
export function argbIntToCss(argb: number): string {
  const red = (argb >>> 16) & 0xff;
  const green = (argb >>> 8) & 0xff;
  const blue = argb & 0xff;
  return `rgb(${red}, ${green}, ${blue})`;
}

/** The member's roles resolved and sorted by position DESC (highest first). */
function memberRolesSorted(member: ServerMember, rolesById: ReadonlyMap<number, Role>): Role[] {
  return member.roleIds
    .map((roleId) => rolesById.get(roleId))
    .filter((role): role is Role => role !== undefined)
    .sort((left, right) => right.position - left.position);
}

/** Highest-position role that carries a color — the nick color source. */
export function memberNameColor(member: ServerMember, roles: readonly Role[]): string | null {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const colored = memberRolesSorted(member, rolesById).find((role) => role.color !== null);
  return colored?.color != null ? argbIntToCss(colored.color) : null;
}

/** The member's highest hoist-role: kind OWNER never hoists; the owner member never hoists either. */
export function topHoistRole(member: ServerMember, roles: readonly Role[]): Role | null {
  if (member.owner) {
    return null;
  }
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  return memberRolesSorted(member, rolesById).find((role) => role.hoist && role.kind !== "OWNER") ?? null;
}

/** Max role position; 0 is the @everyone floor. */
export function topPosition(member: ServerMember, roles: readonly Role[]): number {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  return memberRolesSorted(member, rolesById)[0]?.position ?? 0;
}

export interface HierarchyView {
  owner: boolean;
  /** null = unknown (not in the member snapshot) — treated as actionable; the server decides. */
  topPosition: number | null;
}

/** Client-side mirror of the server's canActOn — a UI HINT for menu visibility only. */
export function canActOn(self: HierarchyView, target: HierarchyView): boolean {
  if (target.owner) {
    return false; // the owner is immune to everyone
  }
  if (self.owner) {
    return true;
  }
  if (target.topPosition === null) {
    return true;
  }
  if (self.topPosition === null) {
    return false;
  }
  return self.topPosition > target.topPosition;
}

function bySelfFirstThenName(selfUsername: string | null): (left: ServerMember, right: ServerMember) => number {
  return (left, right) => {
    const leftSelf = left.username === selfUsername ? 1 : 0;
    const rightSelf = right.username === selfUsername ? 1 : 0;
    if (leftSelf !== rightSelf) {
      return rightSelf - leftSelf;
    }
    return left.username.localeCompare(right.username);
  };
}

export function buildRosterGroups(
  members: readonly ServerMember[],
  roles: readonly Role[],
  presence: ReadonlySet<string>,
  selfUsername: string | null,
): RosterGroup[] {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const hoistBuckets = new Map<number, RosterEntry[]>();
  const online: RosterEntry[] = [];
  const offline: RosterEntry[] = [];

  for (const member of members) {
    const entry: RosterEntry = {
      member,
      nameColor: memberNameColor(member, roles),
      online: presence.has(member.username),
      isSelf: member.username === selfUsername,
    };
    if (!entry.online) {
      offline.push(entry);
      continue;
    }
    const hoistRole = topHoistRole(member, roles);
    if (hoistRole !== null) {
      const bucket = hoistBuckets.get(hoistRole.id) ?? [];
      bucket.push(entry);
      hoistBuckets.set(hoistRole.id, bucket);
    } else {
      online.push(entry);
    }
  }

  const sorter = bySelfFirstThenName(selfUsername);
  const groups: RosterGroup[] = [];
  const hoistRolesSorted = [...hoistBuckets.keys()]
    .map((roleId) => rolesById.get(roleId))
    .filter((role): role is Role => role !== undefined)
    .sort((left, right) => right.position - left.position);
  for (const role of hoistRolesSorted) {
    const entries = (hoistBuckets.get(role.id) ?? []).sort((left, right) => sorter(left.member, right.member));
    groups.push({
      key: `role-${role.id}`,
      title: `${role.name} — ${entries.length}`,
      titleColor: role.color !== null ? argbIntToCss(role.color) : null,
      entries,
    });
  }
  if (online.length > 0) {
    online.sort((left, right) => sorter(left.member, right.member));
    groups.push({ key: "online", title: `Online — ${online.length}`, titleColor: null, entries: online });
  }
  if (offline.length > 0) {
    // oak sorts the offline section by PLAIN ALPHABET — self-first applies to
    // the online buckets only (rebuildMemberNodes: two comparators).
    offline.sort((left, right) => left.member.username.localeCompare(right.member.username));
    groups.push({ key: "offline", title: `Offline — ${offline.length}`, titleColor: null, entries: offline });
  }
  return groups;
}
