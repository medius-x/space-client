import { describe, expect, it } from "vitest";
import {
  applyTriState,
  buildAccessWrites,
  channelEditablePermissions,
  inferAccessMode,
  inferGrantees,
  lockedModeSet,
  modeSetFor,
  overrideMaps,
  permissionMapsEqual,
  triStateOf,
} from "../src/domain/logic/channel-access";
import type { ChannelOverride, ChannelUserOverride, PermissionCatalogEntry } from "../src/types";

/** The writer sorts permission sets — expectations compare sorted too. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

describe("tri-state editing", () => {
  it("deny wins when both sets carry the name (that is the server's resolution)", () => {
    expect(triStateOf("SEND_MESSAGES", { allow: ["SEND_MESSAGES"], deny: ["SEND_MESSAGES"] })).toBe("deny");
    expect(triStateOf("SEND_MESSAGES", { allow: ["SEND_MESSAGES"], deny: [] })).toBe("allow");
    expect(triStateOf("SEND_MESSAGES", { allow: [], deny: [] })).toBe("inherit");
  });

  it("applyTriState moves one permission and keeps the rest sorted", () => {
    const start = { allow: ["AAA", "BBB"], deny: ["CCC"] };
    expect(applyTriState(start, "DDD", "allow")).toEqual({ allow: ["AAA", "BBB", "DDD"], deny: ["CCC"] });
    expect(applyTriState(start, "CCC", "allow")).toEqual({ allow: ["AAA", "BBB", "CCC"], deny: [] });
    expect(applyTriState(start, "AAA", "deny")).toEqual({ allow: ["BBB"], deny: ["AAA", "CCC"] });
    expect(applyTriState(start, "AAA", "inherit")).toEqual({ allow: ["BBB"], deny: ["CCC"] });
  });

  it("the channel editor shows Text/Voice + MANAGE_CHANNELS, never VIEW_CHANNEL", () => {
    const catalog: PermissionCatalogEntry[] = [
      { name: "ADMINISTRATOR", group: "GENERAL" },
      { name: "MANAGE_CHANNELS", group: "GENERAL" },
      { name: "KICK_MEMBERS", group: "GENERAL" },
      { name: "VIEW_CHANNEL", group: "GENERAL" },
      { name: "SEND_MESSAGES", group: "TEXT" },
      { name: "CONNECT", group: "VOICE" },
    ];
    expect(channelEditablePermissions(catalog).map((entry) => entry.name))
      .toEqual(["MANAGE_CHANNELS", "SEND_MESSAGES", "CONNECT"]);
  });

  it("permissionMapsEqual fires on a REMOVED bit as much as on an added one (Save dirty)", () => {
    // Live bug 2026-10-05: the one-sided subset test lit Save only for additions —
    // turning the ONLY Deny back to Inherit left the button dead.
    const saved = new Map([[1, { allow: [], deny: ["SPEAK"] }]]);
    const lifted = new Map([[1, { allow: [], deny: [] }]]);
    expect(permissionMapsEqual(saved, lifted)).toBe(false);
    expect(permissionMapsEqual(lifted, saved)).toBe(false); // direction must not matter

    const unchanged = new Map([[1, { allow: ["AAA"], deny: ["SPEAK"] }]]);
    const sameOrderIgnored = new Map([[1, { allow: ["AAA"], deny: ["SPEAK"] }]]);
    expect(permissionMapsEqual(unchanged, sameOrderIgnored)).toBe(true);

    const allowRemoved = new Map([[2, { allow: [], deny: [] }]]);
    const allowAdded = new Map([[2, { allow: ["AAA"], deny: [] }]]);
    expect(permissionMapsEqual(allowRemoved, allowAdded)).toBe(false);

    const rowAdded = new Map([[3, { allow: [], deny: [] }]]);
    expect(permissionMapsEqual(new Map(), rowAdded)).toBe(false); // a fresh @everyone row differs from none
    expect(permissionMapsEqual(new Map(), new Map())).toBe(true);
  });
});

describe("access mode inference", () => {
  it("hidden = @everyone denies VIEW_CHANNEL; locked = the type's use set; else public", () => {
    expect(inferAccessMode(new Set(["VIEW_CHANNEL"]), "TEXT")).toBe("hidden");
    expect(inferAccessMode(new Set(lockedModeSet("TEXT")), "TEXT")).toBe("locked");
    expect(inferAccessMode(new Set(lockedModeSet("VOICE")), "VOICE")).toBe("locked");
    // A superset still means the mode.
    expect(inferAccessMode(new Set(["VIEW_CHANNEL", "SEND_MESSAGES", "CONNECT"]), "TEXT")).toBe("hidden");
    expect(inferAccessMode(new Set(["SEND_MESSAGES"]), "TEXT")).toBe("public");
  });

  it("modeSetFor: the managed set written for @everyone/grantees", () => {
    expect(modeSetFor("hidden", "TEXT")).toEqual(["VIEW_CHANNEL"]);
    expect(modeSetFor("locked", "TEXT")).toEqual(lockedModeSet("TEXT"));
    expect(modeSetFor("public", "TEXT")).toEqual([]);
  });

  it("grantees = subjects whose allow covers the whole mode set", () => {
    const roleOverrides = new Map([
      [1, { allow: [...modeSetFor("hidden", "TEXT")], deny: [] }],   // full grant
      [2, { allow: ["VIEW_CHANNEL"], deny: [] }],                    // VIEW only — partial for locked, full for hidden
      [3, { allow: [], deny: [] }],                                  // nothing
    ]);
    const userOverrides = new Map([
      [7, { allow: [...modeSetFor("locked", "TEXT")], deny: [] }],
    ]);
    const hidden = inferGrantees("hidden", "TEXT", roleOverrides, userOverrides);
    expect(hidden.roleIds).toEqual([1, 2]); // VIEW_CHANNEL covers the hidden set
    expect(hidden.userIds).toEqual([]);     // user 7 holds the LOCKED set, not the hidden one
    const locked = inferGrantees("locked", "TEXT", roleOverrides, userOverrides);
    expect(locked.roleIds).toEqual([]);     // nobody's allow covers READ+SEND+REACTIONS
    expect(locked.userIds).toEqual([7]);
  });
});

describe("buildAccessWrites (the Access-tab Save)", () => {
  const everyoneRoleId = 1;
  const roleOverrides = overrideMaps(
    [
      { channelId: 3, roleId: 1, allow: [], deny: ["VIEW_CHANNEL"] },                     // @everyone: hidden
      { channelId: 3, roleId: 2, allow: ["VIEW_CHANNEL"], deny: [] },                     // vip: granted
      { channelId: 3, roleId: 3, allow: ["BAN_MEMBERS", "SEND_MESSAGES"], deny: ["CONNECT"] }, // unmanaged bits survive
    ] satisfies ChannelOverride[],
    [],
  ).roleOverrides;
  const userOverrides = overrideMaps([], [
    { channelId: 3, userId: 9, username: "bob", allow: ["VIEW_CHANNEL"], deny: [] },
  ] satisfies ChannelUserOverride[]).userOverrides;

  it("hidden → locked rewrites @everyone's deny and keeps unmanaged bits untouched", () => {
    const writes = buildAccessWrites({
      channelType: "TEXT",
      mode: "locked",
      roleOverrides,
      userOverrides,
      everyoneRoleId,
      grantedRoleIds: [2],
      grantedUserIds: [9],
    });
    const everyoneWrite = writes.find((write) => write.kind === "role" && write.id === everyoneRoleId)!;
    expect(everyoneWrite.deny).toEqual(sorted(lockedModeSet("TEXT"))); // VIEW_CHANNEL left the deny set
    expect(everyoneWrite.remove).toBe(false);
    // vip keeps its grant under the new mode set (VIEW replaced by the locked set).
    const vipWrite = writes.find((write) => write.kind === "role" && write.id === 2)!;
    expect(vipWrite.allow).toEqual(sorted(lockedModeSet("TEXT")));
    // role 3 has no managed bits — its unmanaged allow survives, managed ones drop.
    const roleThree = writes.find((write) => write.kind === "role" && write.id === 3)!;
    expect(roleThree.allow).toEqual(["BAN_MEMBERS"]); // SEND_MESSAGES is managed → cleared
    expect(roleThree.deny).toEqual([]);               // CONNECT is managed → cleared
    expect(roleThree.remove).toBe(false);
  });

  it("public clears every managed bit and deletes rows that end up empty", () => {
    const writes = buildAccessWrites({
      channelType: "TEXT",
      mode: "public",
      roleOverrides,
      userOverrides,
      everyoneRoleId,
      grantedRoleIds: [],
      grantedUserIds: [],
    });
    const everyoneWrite = writes.find((write) => write.kind === "role" && write.id === everyoneRoleId)!;
    expect(everyoneWrite.deny).toEqual([]);
    expect(everyoneWrite.remove).toBe(true); // nothing left → DELETE the row
    const userWrite = writes.find((write) => write.kind === "user" && write.id === 9)!;
    expect(userWrite.remove).toBe(true);
    // role 3 keeps its UNMANAGED bits even in public; the managed CONNECT deny leaves with them.
    const roleThree = writes.find((write) => write.kind === "role" && write.id === 3)!;
    expect(roleThree.allow).toEqual(["BAN_MEMBERS"]);
    expect(roleThree.deny).toEqual([]);
    expect(roleThree.remove).toBe(false);
  });

  it("a brand-new grantee with no existing row still gets one", () => {
    const writes = buildAccessWrites({
      channelType: "TEXT",
      mode: "hidden",
      roleOverrides: new Map([[everyoneRoleId, { allow: [], deny: [] }]]),
      userOverrides: new Map(),
      everyoneRoleId,
      grantedRoleIds: [5],
      grantedUserIds: [11],
    });
    expect(writes).toContainEqual({ kind: "role", id: 5, allow: ["VIEW_CHANNEL"], deny: [], remove: false });
    expect(writes).toContainEqual({ kind: "user", id: 11, allow: ["VIEW_CHANNEL"], deny: [], remove: false });
  });
});
