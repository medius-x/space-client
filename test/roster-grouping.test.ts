import { describe, expect, it } from "vitest";
import {
  argbIntToCss,
  buildRosterGroups,
  canActOn,
  memberNameColor,
  topHoistRole,
  topPosition,
} from "../src/domain/logic/roster-grouping";
import type { Role, ServerMember } from "../src/types";

function role(id: number, overrides: Partial<Role> = {}): Role {
  return {
    id,
    name: `role-${id}`,
    color: null,
    position: id,
    permissions: [],
    mentionable: false,
    hoist: false,
    kind: "CUSTOM",
    ...overrides,
  };
}

function member(userId: number, username: string, overrides: Partial<ServerMember> = {}): ServerMember {
  return { userId, username, avatarUrl: null, roleIds: [], owner: false, banned: false, ...overrides };
}

const RED = 0xffda373c; // -2429124 as a Java int would be on the wire

describe("argbIntToCss", () => {
  it("decodes Java ARGB ints, including negative (high-bit-set) values", () => {
    expect(argbIntToCss(0xffda373c)).toBe("rgb(218, 55, 60)");
    expect(argbIntToCss(0xffda373c - 0x100000000)).toBe("rgb(218, 55, 60)"); // same color, signed form
    expect(argbIntToCss(0x5865f2)).toBe("rgb(88, 101, 242)"); // the blurple itself, without alpha
  });
});

describe("memberNameColor / topHoistRole / topPosition", () => {
  const roles = [
    role(1, { position: 5, color: RED }),          // high, colored
    role(2, { position: 3, hoist: true }),          // high-ish hoist, no color
    role(3, { position: 1, color: 0xff00a8fc }),    // low, colored
  ];
  const rolesById = roles;

  it("nick color = the HIGHEST role that has a color (not just the highest role)", () => {
    const withAll = member(1, "alice", { roleIds: [1, 2, 3] });
    expect(memberNameColor(withAll, rolesById)).toBe("rgb(218, 55, 60)");
    const withoutTop = member(2, "bob", { roleIds: [2, 3] }); // highest has no color → next colored one
    expect(memberNameColor(withoutTop, rolesById)).toBe("rgb(0, 168, 252)");
    expect(memberNameColor(member(3, "carol"), rolesById)).toBeNull(); // no roles at all
  });

  it("hoist = the highest hoist role; the OWNER member never hoists", () => {
    expect(topHoistRole(member(1, "alice", { roleIds: [2] }), rolesById)?.id).toBe(2);
    expect(topHoistRole(member(1, "alice", { roleIds: [2, 3] }), rolesById)?.id).toBe(2);
    expect(topHoistRole(member(1, "alice", { roleIds: [3] }), rolesById)).toBeNull(); // not hoisted
    expect(topHoistRole(member(1, "alice", { roleIds: [2], owner: true }), rolesById)).toBeNull();
  });

  it("OWNER-kind roles never hoist", () => {
    const ownerRole = [role(9, { position: 10, hoist: true, kind: "OWNER" }), role(2, { position: 3, hoist: true })];
    expect(topHoistRole(member(1, "alice", { roleIds: [9, 2] }), ownerRole)?.id).toBe(2);
  });

  it("topPosition = max role position, @everyone floor at 0", () => {
    expect(topPosition(member(1, "alice", { roleIds: [3, 1] }), rolesById)).toBe(5);
    expect(topPosition(member(1, "alice"), rolesById)).toBe(0);
  });
});

describe("buildRosterGroups", () => {
  it("hoist buckets above plain Online, groups by role position desc, offline last without hoist", () => {
    const roles = [
      role(1, { position: 2, name: "mods", hoist: true, color: RED }),
      role(2, { position: 5, name: "vip", hoist: true }),
    ];
    const members = [
      member(1, "zoe", { roleIds: [1] }),           // mods, online
      member(2, "alice"),                            // plain online
      member(3, "bob", { roleIds: [2] }),           // vip, online
      member(4, "carol", { roleIds: [2] }),         // vip but OFFLINE → no hoist
      member(5, "dave"),                             // offline
    ];
    const groups = buildRosterGroups(members, roles, new Set(["zoe", "alice", "bob"]), "alice");

    expect(groups.map((group) => group.key)).toEqual(["role-2", "role-1", "online", "offline"]);
    expect(groups[0]!.title).toBe("vip — 1");                       // higher position first
    expect(groups[0]!.titleColor).toBeNull();                        // vip has no color
    expect(groups[0]!.entries.map((entry) => entry.member.username)).toEqual(["bob"]);
    expect(groups[1]!.title).toBe("mods — 1");                       // colored hoist header
    expect(groups[1]!.titleColor).toBe("rgb(218, 55, 60)");
    expect(groups[1]!.entries.map((entry) => entry.member.username)).toEqual(["zoe"]);
    expect(groups[2]!.title).toBe("Online — 1");
    expect(groups[2]!.entries.map((entry) => entry.member.username)).toEqual(["alice"]);
    expect(groups[3]!.title).toBe("Offline — 2");
    expect(groups[3]!.entries.map((entry) => entry.member.username)).toEqual(["carol", "dave"]); // alphabetical, no hoist
  });

  it("self always sorts first inside every group", () => {
    const members = [member(1, "zed"), member(2, "beta"), member(3, "alpha")];
    const groups = buildRosterGroups(members, [], new Set(["zed", "beta", "alpha"]), "zed");
    expect(groups[0]!.entries.map((entry) => entry.member.username)).toEqual(["zed", "alpha", "beta"]);
  });

  it("empty groups never render (all online in hoist buckets → no plain Online header)", () => {
    const roles = [role(1, { position: 1, name: "mods", hoist: true })];
    const members = [member(1, "alice", { roleIds: [1] })];
    const groups = buildRosterGroups(members, roles, new Set(["alice"]), "alice");
    expect(groups.map((group) => group.key)).toEqual(["role-1"]);
  });
});

describe("canActOn (client hint for menu visibility)", () => {
  it("the owner is immune; owner acts on everyone else", () => {
    expect(canActOn({ owner: false, topPosition: 9 }, { owner: true, topPosition: 0 })).toBe(false);
    expect(canActOn({ owner: true, topPosition: 0 }, { owner: false, topPosition: 9 })).toBe(true);
  });

  it("equal or lower hierarchy cannot act; strictly higher can", () => {
    expect(canActOn({ owner: false, topPosition: 3 }, { owner: false, topPosition: 3 })).toBe(false);
    expect(canActOn({ owner: false, topPosition: 3 }, { owner: false, topPosition: 2 })).toBe(true);
  });

  it("an unknown target stays actionable — the server decides", () => {
    expect(canActOn({ owner: false, topPosition: 0 }, { owner: false, topPosition: null })).toBe(true);
  });
});
