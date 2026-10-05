import type { ChannelOverride, ChannelType, ChannelUserOverride, PermissionCatalogEntry } from "../../types";

/**
 * Pure RBAC-editor math for the channel Permissions/Access tabs (oak parity).
 *
 * Wire tri-state: a permission is in `allow`, in `deny` (deny wins), or in
 * NEITHER (neutral — the role's base applies). PUT replaces both sets wholesale,
 * DELETE removes the row (a {[],[]} PUT leaves a functionally-neutral row behind).
 *
 * Access modes are NOT a server field — they are a UI convention over the
 * @everyone override, inferred on load and written back as managed sets:
 *   Locked  = @everyone denies READ/SEND (+reactions) on TEXT, CONNECT/SPEAK on VOICE;
 *   Hidden  = @everyone denies VIEW_CHANNEL (grantees get it allowed);
 *   Public  = no managed @everyone denies.
 */

export type TriState = "allow" | "deny" | "inherit";

export interface PermissionSets {
  allow: string[];
  deny: string[];
}

export const MANAGE_CHANNELS_PERMISSION_NAME = "MANAGE_CHANNELS";
export const VIEW_CHANNEL_PERMISSION_NAME = "VIEW_CHANNEL";

/** The only permissions the Access tab owns — everything else survives its Saves untouched. */
export const ACCESS_MANAGED_PERMISSIONS: readonly string[] = [
  "VIEW_CHANNEL",
  "READ_MESSAGE_HISTORY",
  "SEND_MESSAGES",
  "ADD_REACTIONS",
  "CONNECT",
  "SPEAK",
];

/** What "Locked" denies for @everyone (and allows for the listed grantees). */
export function lockedModeSet(channelType: ChannelType): string[] {
  return channelType === "VOICE"
    ? ["CONNECT", "SPEAK"]
    : ["READ_MESSAGE_HISTORY", "SEND_MESSAGES", "ADD_REACTIONS"];
}

export const HIDDEN_MODE_SET: readonly string[] = ["VIEW_CHANNEL"];

export type AccessMode = "public" | "locked" | "hidden";

/** Infer the mode from the CURRENT @everyone deny set (a superset means the mode). */
export function inferAccessMode(everyoneDeny: ReadonlySet<string>, channelType: ChannelType): AccessMode {
  if (containsAll(everyoneDeny, HIDDEN_MODE_SET)) {
    return "hidden";
  }
  if (containsAll(everyoneDeny, lockedModeSet(channelType))) {
    return "locked";
  }
  return "public";
}

/** The managed set a mode writes for @everyone/grantees ([] = public clears them). */
export function modeSetFor(mode: AccessMode, channelType: ChannelType): string[] {
  return mode === "hidden"
    ? [...HIDDEN_MODE_SET]
    : mode === "locked"
      ? lockedModeSet(channelType)
      : [];
}

/**
 * Which roles/members currently HOLD access under the inferred mode: their
 * override's allow contains the whole mode set.
 */
export function inferGrantees(
  mode: AccessMode,
  channelType: ChannelType,
  roleOverrides: ReadonlyMap<number, PermissionSets>,
  userOverrides: ReadonlyMap<number, PermissionSets>,
): { roleIds: number[]; userIds: number[] } {
  const modeSet = modeSetFor(mode, channelType);
  const holdsAccess = (sets: PermissionSets): boolean =>
    modeSet.length > 0 && containsAll(new Set(sets.allow), modeSet);
  const roleIds: number[] = [];
  for (const [roleId, sets] of roleOverrides) {
    if (holdsAccess(sets)) {
      roleIds.push(roleId);
    }
  }
  const userIds: number[] = [];
  for (const [userId, sets] of userOverrides) {
    if (holdsAccess(sets)) {
      userIds.push(userId);
    }
  }
  return { roleIds, userIds };
}

function containsAll(set: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((name) => set.has(name));
}

function withoutManaged(names: readonly string[]): string[] {
  return names.filter((name) => !ACCESS_MANAGED_PERMISSIONS.includes(name));
}

// ---------------------------------------------------------------------------
// Tri-state editing (the Permissions tab)
// ---------------------------------------------------------------------------

export function triStateOf(permission: string, sets: PermissionSets): TriState {
  if (sets.deny.includes(permission)) {
    return "deny"; // deny wins even if both are set — that is the server's resolution
  }
  if (sets.allow.includes(permission)) {
    return "allow";
  }
  return "inherit";
}

/** Pure transition of one permission into new allow/deny sets. */
export function applyTriState(sets: PermissionSets, permission: string, next: TriState): PermissionSets {
  const allow = new Set(sets.allow);
  const deny = new Set(sets.deny);
  allow.delete(permission);
  deny.delete(permission);
  if (next === "allow") {
    allow.add(permission);
  } else if (next === "deny") {
    deny.add(permission);
  }
  return { allow: [...allow].sort(), deny: [...deny].sort() };
}

/** Whether two override maps carry the same allow/deny sets — the Permissions tab's
 *  dirty check. Equality must fire on a REMOVED bit as much as on an added one: a
 *  one-sided subset test lit Save only for additions, so turning the only Deny back
 *  to Inherit left the button dead (live smoke 2026-10-05). */
export function permissionMapsEqual(
  left: ReadonlyMap<number, PermissionSets>,
  right: ReadonlyMap<number, PermissionSets>,
): boolean {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftSets = left.get(key);
    const rightSets = right.get(key);
    if (leftSets === undefined && rightSets === undefined) {
      continue;
    }
    if (leftSets === undefined || rightSets === undefined) {
      return false;
    }
    const allowUnion = new Set([...leftSets.allow, ...rightSets.allow]);
    const denyUnion = new Set([...leftSets.deny, ...rightSets.deny]);
    if (new Set(leftSets.allow).size !== allowUnion.size
        || new Set(rightSets.allow).size !== allowUnion.size
        || new Set(leftSets.deny).size !== denyUnion.size
        || new Set(rightSets.deny).size !== denyUnion.size) {
      return false;
    }
  }
  return true;
}

/** The channel Permissions tab shows Text+Voice groups plus MANAGE_CHANNELS; VIEW_CHANNEL belongs to Access. */
export function channelEditablePermissions(catalog: readonly PermissionCatalogEntry[]): PermissionCatalogEntry[] {
  return catalog.filter((entry) =>
    entry.group !== "GENERAL" || entry.name === MANAGE_CHANNELS_PERMISSION_NAME,
  ).filter((entry) => entry.name !== VIEW_CHANNEL_PERMISSION_NAME);
}

// ---------------------------------------------------------------------------
// Access editing (the Access tab) — one Save turns a working set into REST calls
// ---------------------------------------------------------------------------

export interface AccessWrite {
  kind: "role" | "user";
  id: number;
  allow: string[];
  deny: string[];
  /** true = DELETE the row (both sets empty after the managed surgery). */
  remove: boolean;
}

export interface AccessEditInput {
  channelType: ChannelType;
  mode: AccessMode;
  /** Role overrides as loaded from the server (INCLUDING @everyone's row, keyed by its role id). */
  roleOverrides: ReadonlyMap<number, PermissionSets>;
  userOverrides: ReadonlyMap<number, PermissionSets>;
  everyoneRoleId: number;
  /** Roles/members that should keep access under the chosen mode. */
  grantedRoleIds: readonly number[];
  grantedUserIds: readonly number[];
}

/**
 * oak's write recipe: @everyone deny = (old − managed) ∪ modeSet; grantees get
 * the modeSet ALLOWED (minus nothing); everyone else loses the managed bits;
 * rows that end up with both sets empty are DELETED. Unmanaged values survive.
 */
export function buildAccessWrites(input: AccessEditInput): AccessWrite[] {
  const modeSet = input.mode === "hidden"
    ? [...HIDDEN_MODE_SET]
    : input.mode === "locked"
      ? lockedModeSet(input.channelType)
      : [];
  const writes: AccessWrite[] = [];

  const everyone = input.roleOverrides.get(input.everyoneRoleId) ?? { allow: [], deny: [] };
  const everyoneDeny = [...new Set([...withoutManaged(everyone.deny), ...modeSet])].sort();
  const everyoneAllow = withoutManaged(everyone.allow).sort();
  writes.push({
    kind: "role",
    id: input.everyoneRoleId,
    allow: everyoneAllow,
    deny: everyoneDeny,
    remove: everyoneAllow.length === 0 && everyoneDeny.length === 0,
  });

  for (const [roleId, sets] of input.roleOverrides) {
    if (roleId === input.everyoneRoleId) {
      continue;
    }
    const granted = input.grantedRoleIds.includes(roleId);
    writes.push(buildGrantWrite("role", roleId, sets, granted, modeSet));
  }
  // A role granted access that had NO row yet still needs one created.
  for (const roleId of input.grantedRoleIds) {
    if (!input.roleOverrides.has(roleId) && modeSet.length > 0) {
      writes.push({ kind: "role", id: roleId, allow: [...modeSet], deny: [], remove: false });
    }
  }

  for (const [userId, sets] of input.userOverrides) {
    const granted = input.grantedUserIds.includes(userId);
    writes.push(buildGrantWrite("user", userId, sets, granted, modeSet));
  }
  for (const userId of input.grantedUserIds) {
    if (!input.userOverrides.has(userId) && modeSet.length > 0) {
      writes.push({ kind: "user", id: userId, allow: [...modeSet], deny: [], remove: false });
    }
  }

  return writes;
}

function buildGrantWrite(kind: "role" | "user", id: number, sets: PermissionSets, granted: boolean, modeSet: string[]): AccessWrite {
  const allow = new Set(withoutManaged(sets.allow));
  const deny = withoutManaged(sets.deny);
  if (granted) {
    for (const name of modeSet) {
      allow.add(name);
    }
  }
  const sortedAllow = [...allow].sort();
  return { kind, id, allow: sortedAllow, deny, remove: sortedAllow.length === 0 && deny.length === 0 };
}

/** Parse the loaded override rows into the maps the editor works with. */
export function overrideMaps(roleOverrides: readonly ChannelOverride[], userOverrides: readonly ChannelUserOverride[]): {
  roleOverrides: Map<number, PermissionSets>;
  userOverrides: Map<number, PermissionSets>;
} {
  return {
    roleOverrides: new Map(roleOverrides.map((row) => [row.roleId, { allow: row.allow, deny: row.deny }])),
    userOverrides: new Map(userOverrides.map((row) => [row.userId, { allow: row.allow, deny: row.deny }])),
  };
}
