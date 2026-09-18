import { describe, expect, it } from "vitest";
import {
  acceleratorFromKeyboardEvent,
  adjacentChannelId,
  DEFAULT_KEYBINDS,
  findAcceleratorConflicts,
  formatAccelerator,
  globalBindingsForSync,
  isBareKeyAccelerator,
  KEYBIND_ACTIONS,
  normalizeAccelerator,
  resolveKeybinds,
  voiceSurfaceFor,
} from "../src/domain/logic/keybinds";

function keyEvent(partial: Partial<Parameters<typeof acceleratorFromKeyboardEvent>[0]>): Parameters<typeof acceleratorFromKeyboardEvent>[0] {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: "KeyM", ...partial };
}

describe("acceleratorFromKeyboardEvent (event.code → canonical accelerator)", () => {
  it("maps codes to Electron tokens with modifiers in canonical order", () => {
    expect(acceleratorFromKeyboardEvent(keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyM" }))).toBe("Control+Shift+M");
    expect(acceleratorFromKeyboardEvent(keyEvent({ altKey: true, code: "ArrowDown" }))).toBe("Alt+Down");
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "Digit1" }))).toBe("1");
    expect(acceleratorFromKeyboardEvent(keyEvent({ metaKey: true, code: "KeyK" }))).toBe("Meta+K");
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "Numpad7" }))).toBe("7");
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "F12" }))).toBe("F12");
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "Minus" }))).toBe("-");
  });

  it("null while only modifiers are held or the code has no token", () => {
    expect(acceleratorFromKeyboardEvent(keyEvent({ ctrlKey: true, code: "ControlLeft" }))).toBeNull();
    expect(acceleratorFromKeyboardEvent(keyEvent({ shiftKey: true, code: "ShiftLeft" }))).toBeNull();
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "IntlRo" }))).toBeNull();
    expect(acceleratorFromKeyboardEvent(keyEvent({ code: "MediaPlayPause" }))).toBeNull();
  });
});

describe("normalizeAccelerator (stored/hand-written → canonical)", () => {
  it("resolves aliases and reorders modifiers", () => {
    expect(normalizeAccelerator("Ctrl+Shift+M")).toBe("Control+Shift+M");
    expect(normalizeAccelerator("Shift+Control+M")).toBe("Control+Shift+M");
    expect(normalizeAccelerator("Ctrl+Cmd+K")).toBe("Control+Meta+K");
    expect(normalizeAccelerator("CmdOrCtrl+Enter")).toBe("Control+Return");
    expect(normalizeAccelerator("Esc")).toBe("Escape");
    expect(normalizeAccelerator("Alt+ArrowDown")).toBe("Alt+Down");
  });

  it("null on garbage", () => {
    expect(normalizeAccelerator("")).toBeNull();
    expect(normalizeAccelerator("Control+Alt")).toBeNull(); // modifiers only
    expect(normalizeAccelerator("Control+Nonsense")).toBeNull();
    expect(normalizeAccelerator("M+K")).toBeNull(); // two key tokens
  });
});

describe("formatAccelerator (display form)", () => {
  it("shortens modifiers and arrows", () => {
    expect(formatAccelerator("Control+Shift+M")).toBe("Ctrl+Shift+M");
    expect(formatAccelerator("Alt+Down")).toBe("Alt+↓");
    expect(formatAccelerator("Meta+Return")).toBe("Win+Enter");
  });

  it("empty binding renders as Not bound", () => {
    expect(formatAccelerator("")).toBe("Not bound");
  });
});

describe("isBareKeyAccelerator (global single-key warning)", () => {
  it("true only for a modifier-less single key", () => {
    expect(isBareKeyAccelerator("M")).toBe(true);
    expect(isBareKeyAccelerator("Control+M")).toBe(false);
    expect(isBareKeyAccelerator("Alt+M")).toBe(false);
    expect(isBareKeyAccelerator("")).toBe(false);
  });
});

describe("resolveKeybinds (defaults ⊕ stored)", () => {
  it("fills defaults for actions with nothing stored", () => {
    expect(resolveKeybinds({})).toEqual(DEFAULT_KEYBINDS);
  });

  it("an explicit empty string unbinds a defaulted action", () => {
    expect(resolveKeybinds({ "toggle-mute": "" })["toggle-mute"]).toBe("");
  });

  it("a garbage value falls back to the default, unknown ids are dropped", () => {
    // "quick-switcher" simulates a bind a NEWER client once wrote — the cast is
    // the point: stored data is not type-checked at runtime.
    const stored = { "toggle-deafen": "Ctrl+", "quick-switcher": "Control+K" } as Partial<Record<keyof typeof DEFAULT_KEYBINDS, string>>;
    const resolved = resolveKeybinds(stored);
    expect(resolved["toggle-deafen"]).toBe(DEFAULT_KEYBINDS["toggle-deafen"]);
    expect("quick-switcher" in resolved).toBe(false);
  });

  it("non-canonical stored chords are canonicalized", () => {
    expect(resolveKeybinds({ "accept-call": "Ctrl+Enter" })["accept-call"]).toBe("Control+Return");
  });
});

describe("findAcceleratorConflicts", () => {
  it("flags duplicates across scopes and ignores unbound", () => {
    const conflicts = findAcceleratorConflicts({
      ...DEFAULT_KEYBINDS,
      "next-channel": "Control+Shift+M", // clashes with the global toggle-mute
      "decline-call": "", // unbound — never conflicts
    });
    expect(conflicts.get("Control+Shift+M")).toEqual(["toggle-mute", "next-channel"]);
    expect(conflicts.size).toBe(1);
  });

  it("a three-way duplicate lists all holders", () => {
    const conflicts = findAcceleratorConflicts({
      ...DEFAULT_KEYBINDS,
      "toggle-deafen": "Control+Shift+M",
      "accept-call": "Control+Shift+M",
    });
    expect(conflicts.get("Control+Shift+M")).toEqual(["toggle-mute", "toggle-deafen", "accept-call"]);
  });
});

describe("globalBindingsForSync (the main-process payload)", () => {
  it("carries only global non-empty binds, deterministically sorted", () => {
    const payload = globalBindingsForSync({ ...DEFAULT_KEYBINDS, "toggle-deafen": "", "next-channel": "Control+K" });
    expect(payload.map((entry) => entry.id)).toEqual([
      "toggle-mute",
      "toggle-noise-suppression",
    ]);
    // Same input → same JSON (the change detector compares serialized payloads).
    expect(JSON.stringify(globalBindingsForSync(DEFAULT_KEYBINDS))).toBe(JSON.stringify(globalBindingsForSync({ ...DEFAULT_KEYBINDS })));
  });
});

describe("voiceSurfaceFor (the mute dispatcher gate)", () => {
  it("a live call beats the room; ringing-in leaves the room owning the mic", () => {
    const inRoom = { callState: "idle", activeVoiceChannelId: 5 };
    expect(voiceSurfaceFor({ ...inRoom, callState: "in-call" })).toBe("call");
    expect(voiceSurfaceFor({ ...inRoom, callState: "connecting" })).toBe("call");
    expect(voiceSurfaceFor({ ...inRoom, callState: "ringing-out" })).toBe("call");
    // The incoming ring has NOT captured a call mic yet — sitting in a room, the
    // room keeps the mic and the hotkey mutes THE ROOM until Accept wins.
    expect(voiceSurfaceFor({ ...inRoom, callState: "ringing-in" })).toBe("room");
    expect(voiceSurfaceFor({ callState: "ringing-in", activeVoiceChannelId: null })).toBe("none");
    expect(voiceSurfaceFor(inRoom)).toBe("room");
    expect(voiceSurfaceFor({ callState: "idle", activeVoiceChannelId: null })).toBe("none");
  });
});

describe("adjacentChannelId (the keyboard channel walk)", () => {
  const channels = [
    { id: 1, type: "TEXT" },
    { id: 2, type: "VOICE" },
    { id: 3, type: "TEXT" },
    { id: 4, type: "TEXT" },
  ];

  it("steps through TEXT channels only, clamping at the edges", () => {
    expect(adjacentChannelId(channels, 1, 1)).toBe(3);
    expect(adjacentChannelId(channels, 3, -1)).toBe(1);
    expect(adjacentChannelId(channels, 3, 1)).toBe(4);
    expect(adjacentChannelId(channels, 1, -1)).toBeNull();
    expect(adjacentChannelId(channels, 4, 1)).toBeNull();
  });

  it("no current channel lands on the edge; unknown ids null", () => {
    expect(adjacentChannelId(channels, null, 1)).toBe(1);
    expect(adjacentChannelId(channels, null, -1)).toBe(4);
    expect(adjacentChannelId(channels, 2, 1)).toBeNull(); // the VOICE channel is not on the walk
    expect(adjacentChannelId([], null, 1)).toBeNull();
  });
});

describe("catalog sanity", () => {
  it("ids are unique and no two defaults share an accelerator", () => {
    const ids = KEYBIND_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    const defaults = KEYBIND_ACTIONS
      .map((action) => action.defaultAccelerator)
      .filter((accelerator): accelerator is string => accelerator !== null);
    expect(new Set(defaults).size).toBe(defaults.length);
  });

  it("every default round-trips normalizeAccelerator", () => {
    for (const accelerator of Object.values(DEFAULT_KEYBINDS)) {
      if (accelerator !== "") {
        expect(normalizeAccelerator(accelerator)).toBe(accelerator);
      }
    }
  });
});
