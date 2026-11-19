import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ICON_MAX_LENGTH,
  ACTIVITY_KINDS,
  ACTIVITY_NAME_MAX_LENGTH,
  activityKindKey,
  isActivityKind,
  matchRunningActivity,
  reportableRules,
  normalizeProcessName,
  sanitizeActivity,
  sanitizeActivityIcon,
  trackProcessDetection,
} from "../src/domain/logic/activity";
import { sanitizeRegisteredActivities } from "../src/domain/stores/SettingsStore";
import { RosterStore } from "../src/domain/stores/RosterStore";

describe("sanitizeActivity (the wire-shape guard)", () => {
  it("accepts every registered kind and trims the name", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(sanitizeActivity({ type: kind, name: "  CS2  " })).toEqual({ type: kind, name: "CS2" });
    }
  });

  it("rejects unknown verbs, blank and oversized names, and garbage", () => {
    expect(sanitizeActivity(null)).toBeNull();
    expect(sanitizeActivity("playing")).toBeNull();
    expect(sanitizeActivity({ type: "dancing", name: "polka" })).toBeNull();
    expect(sanitizeActivity({ type: "playing", name: "   " })).toBeNull();
    expect(sanitizeActivity({ type: "playing", name: "x".repeat(ACTIVITY_NAME_MAX_LENGTH + 1) })).toBeNull();
  });

  it("activityKindKey is the i18n key of the verb prefix", () => {
    expect(activityKindKey("playing")).toBe("activity.playing");
    expect(isActivityKind("listening")).toBe(true);
    expect(isActivityKind("singing")).toBe(false);
  });
});

describe("normalizeProcessName (the rule's exe key)", () => {
  it("basenames, lowercases and requires the .exe tail", () => {
    expect(normalizeProcessName("CS2.exe")).toBe("cs2.exe");
    expect(normalizeProcessName("C:\\Games\\Steam\\CS2.EXE")).toBe("cs2.exe");
    expect(normalizeProcessName(" spotify.exe ")).toBe("spotify.exe");
  });

  it("rejects non-exe, paths-as-names leftovers, and oversized junk", () => {
    expect(normalizeProcessName(null)).toBeNull();
    expect(normalizeProcessName("game.txt")).toBeNull();
    expect(normalizeProcessName("")).toBeNull();
    expect(normalizeProcessName("x".repeat(120) + ".exe")).toBeNull();
  });
});

describe("matchRunningActivity (the auto-detect verdict)", () => {
  const rules = [
    { id: "a", processName: "cs2.exe", type: "playing" as const, name: "CS2" },
    { id: "b", processName: "spotify.exe", type: "listening" as const, name: "radio" },
  ];

  it("the FIRST registered rule whose process runs wins", () => {
    expect(matchRunningActivity(rules, ["csrss.exe", "cs2.exe"])).toEqual({ type: "playing", name: "CS2" });
    expect(matchRunningActivity(rules, ["spotify.exe", "cs2.exe"])?.name).toBe("CS2"); // order, not alphabetical
  });

  it("nothing matching — no line at all", () => {
    expect(matchRunningActivity(rules, ["explorer.exe"])).toBeNull();
    expect(matchRunningActivity([], ["cs2.exe"])).toBeNull();
  });

  it("LIFO: the LATEST-detected matching exe wins; closing it falls back (user request 2026-11-11)", () => {
    const stamps = new Map([["cs2.exe", 1_000], ["spotify.exe", 2_000]]); // spotify launched later
    expect(matchRunningActivity(rules, ["cs2.exe", "spotify.exe"], stamps)?.name).toBe("radio");
    expect(matchRunningActivity(rules, ["cs2.exe"], stamps)?.name).toBe("CS2"); // spotify closed
  });

  it("equal stamps (one poll saw both) keep the FIRST registered rule", () => {
    const stamps = new Map([["cs2.exe", 5_000], ["spotify.exe", 5_000]]);
    expect(matchRunningActivity(rules, ["cs2.exe", "spotify.exe"], stamps)?.name).toBe("CS2");
  });
});

describe("trackProcessDetection (the LIFO stamp tracker)", () => {
  it("new names stamp NOW, leaving names drop their stamp, a restart re-stamps", () => {
    const stamps = new Map<string, number>();
    trackProcessDetection(stamps, ["cs2.exe"], 1_000);
    trackProcessDetection(stamps, ["cs2.exe", "spotify.exe"], 2_000); // spotify arrives
    expect(stamps.get("spotify.exe")).toBe(2_000);
    trackProcessDetection(stamps, ["spotify.exe"], 3_000); // cs2 closed — stamp gone
    expect(stamps.has("cs2.exe")).toBe(false);
    trackProcessDetection(stamps, ["cs2.exe", "spotify.exe"], 4_000); // cs2 restarted — NEWER than spotify
    expect(stamps.get("cs2.exe")).toBe(4_000);
    expect(stamps.get("spotify.exe")).toBe(2_000); // untouched, not re-stamped
  });
});

describe("sanitizeRegisteredActivities (client settings)", () => {
  it("keeps valid unique rows, drops garbage, duplicate ids and non-exe rows", () => {
    const sanitized = sanitizeRegisteredActivities([
      { id: "a", processName: "CS2.exe", type: "playing", name: "CS2", icon: "data:image/png;base64,AAAA" },
      { id: "a", processName: "dup.exe", type: "playing", name: "duplicate id" },
      { id: "b", processName: "game.txt", type: "playing", name: "not an exe" },
      { id: "c", processName: "spotify.exe", type: "listening", name: "radio", icon: 42 },
      "garbage",
    ]);
    expect(sanitized).toEqual([
      { id: "a", processName: "cs2.exe", type: "playing", name: "CS2", icon: "data:image/png;base64,AAAA" },
      { id: "c", processName: "spotify.exe", type: "listening", name: "radio", icon: null },
    ]);
  });

  it("non-array KV becomes empty", () => {
    expect(sanitizeRegisteredActivities(null)).toEqual([]);
    expect(sanitizeRegisteredActivities("nope")).toEqual([]);
  });

  it("one rule per exe: legacy duplicate rows drop, the FIRST survives", () => {
    const sanitized = sanitizeRegisteredActivities([
      { id: "a", processName: "mpc-hc64.exe", type: "playing", name: "first" },
      { id: "b", processName: "MPC-HC64.exe", type: "watching", name: "second (same exe, case-insensitive)" },
      { id: "c", processName: "spotify.exe", type: "listening", name: "kept" },
    ]);
    expect(sanitized).toEqual([
      { id: "a", processName: "mpc-hc64.exe", type: "playing", name: "first", icon: null },
      { id: "c", processName: "spotify.exe", type: "listening", name: "kept", icon: null },
    ]);
  });

  it("the persisted icon must be a small data-URL image", () => {
    expect(sanitizeActivityIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(sanitizeActivityIcon(null)).toBeNull();
    expect(sanitizeActivityIcon("https://evil.example/icon.png")).toBeNull(); // not a data URL
    expect(sanitizeActivityIcon("data:text/html,payload")).toBeNull(); // not an image
    expect(sanitizeActivityIcon("data:image/png;base64," + "A".repeat(ACTIVITY_ICON_MAX_LENGTH + 1))).toBeNull(); // oversized
  });
});

describe("RosterStore activity dimension (the snapshot/delta discipline)", () => {
  const seeded = (): RosterStore => {
    const store = new RosterStore();
    store.beginActivitySnapshot();
    store.setActivities([
      { username: "alice", activity: { type: "playing", name: "CS2" } },
      { username: "bob", activity: { type: "listening", name: "radio" } },
    ]);
    return store;
  };

  it("a delta applies; a same-value delta is a no-op", () => {
    const store = seeded();
    store.applyActivityEvent({ username: "bob", activity: null }); // bob clears
    expect(store.getSnapshot().activities.get("bob")).toBeUndefined();
    const before = store.getSnapshot();
    store.applyActivityEvent({ username: "alice", activity: { type: "playing", name: "CS2" } }); // same
    expect(store.getSnapshot()).toBe(before); // no emit, same snapshot object

    store.applyActivityEvent({ username: "carol", activity: { type: "watching", name: "a film" } });
    expect(store.getSnapshot().activities.get("carol")).toEqual({ type: "watching", name: "a film" });
  });

  it("a delta racing the snapshot replays over it (last write wins)", () => {
    const store = new RosterStore();
    store.beginActivitySnapshot();
    store.applyActivityEvent({ username: "alice", activity: null }); // buffered: alice JUST cleared
    store.setActivities([{ username: "alice", activity: { type: "playing", name: "CS2" } }]);
    expect(store.getSnapshot().activities.has("alice")).toBe(false); // the clear survived the seed
  });

  it("presence OFFLINE drops the line locally (the server clear is silent)", () => {
    const store = seeded();
    store.applyPresenceEvent({ username: "alice", status: "OFFLINE" });
    expect(store.getSnapshot().activities.has("alice")).toBe(false);
    expect(store.getSnapshot().activities.get("bob")).toBeDefined(); // others untouched
  });
});

describe("reportableRules (the hidden manual-activity filter)", () => {
  const rules = [
    { id: "1", processName: "cs2.exe", type: "playing" as const, name: "CS2" },
    { id: "2", processName: "radio.exe", type: "listening" as const, name: "Radio" },
    { id: "3", processName: "b.exe", type: "playing" as const, name: "  cs2 " },
  ];

  it("drops every rule writing a hidden name (case/space-insensitive), keeps the rest", () => {
    const kept = reportableRules(rules, new Set(["cs2"]));
    expect(kept.map((rule) => rule.id)).toEqual(["2"]); // both CS2 spellings gone
  });

  it("an empty hidden set keeps everything", () => {
    expect(reportableRules(rules, new Set())).toHaveLength(3);
  });
});
