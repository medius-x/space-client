/**
 * The keybind catalog and the pure accelerator algebra (user decision 2026-09-18:
 * configurable hotkeys with GLOBAL binds that fire while the window has no focus —
 * the mute-from-a-game case). The canonical storage format is the Electron
 * accelerator string ("Control+Shift+M", modifiers first in a fixed order, then
 * ONE key token); "" = the action ships unbound.
 *
 * Scope split: GLOBAL actions register through the OS (Electron globalShortcut in
 * the main process — they fire in fullscreen games and never steal focus); LOCAL
 * actions match a window keydown in the renderer only. The two paths never mix —
 * a global chord still fires through the OS hook while the window IS focused, so
 * a local match for the same action would double-toggle.
 */

export type KeybindScope = "global" | "local";

export type ActionId =
  | "toggle-mute"
  | "toggle-deafen"
  | "toggle-noise-suppression"
  | "accept-call"
  | "decline-call"
  | "next-channel"
  | "prev-channel"
  | "mark-channel-read";

export interface KeybindAction {
  id: ActionId;
  label: string;
  /** A one-line hint under the label (what the action does, Discord-style). */
  hint: string;
  scope: KeybindScope;
  /** null = ships unbound (the user binds it deliberately). */
  defaultAccelerator: string | null;
}

/** Display order: the global group first, then the in-app group. Defaults mirror
 *  Discord's chords (Ctrl+Shift+M/D/N, Ctrl+Enter) — except decline (Discord's Esc
 *  is overlay-scoped; a GLOBAL Esc would swallow Escape for the whole OS) and
 *  mark-read (same reason, in-app Esc is load-bearing for modal close). */
export const KEYBIND_ACTIONS: readonly KeybindAction[] = [
  {
    id: "toggle-mute",
    label: "Toggle Mute",
    hint: "Mutes/unmutes your microphone — in a call, or in the voice room",
    scope: "global",
    defaultAccelerator: "Control+Shift+M",
  },
  {
    id: "toggle-deafen",
    label: "Toggle Deafen",
    hint: "Deafens/undeafens you (and mutes your mic while deafened)",
    scope: "global",
    defaultAccelerator: "Control+Shift+D",
  },
  {
    id: "toggle-noise-suppression",
    label: "Toggle Noise Suppression",
    hint: "Switches the noise-suppression engine off and back",
    scope: "global",
    defaultAccelerator: "Control+Shift+N",
  },
  {
    id: "accept-call",
    label: "Answer Incoming Call",
    hint: "Accepts a ringing call",
    // UNBOUND, deliberately not Discord's Ctrl+Enter: an OS-wide chord swallows
    // the key for every app — and Ctrl+Enter is the composer's NEWLINE (oak's
    // input contract; with ctrlEnterSends it is the SEND key). The user binds
    // this action to a chord that is free on their machine.
    scope: "global",
    defaultAccelerator: null,
  },
  {
    id: "decline-call",
    label: "Decline Incoming Call",
    hint: "Rejects a ringing call",
    scope: "global",
    defaultAccelerator: null,
  },
  {
    id: "next-channel",
    label: "Next Channel",
    hint: "Moves to the next text channel in the sidebar",
    scope: "local",
    defaultAccelerator: "Alt+Down",
  },
  {
    id: "prev-channel",
    label: "Previous Channel",
    hint: "Moves to the previous text channel in the sidebar",
    scope: "local",
    defaultAccelerator: "Alt+Up",
  },
  {
    id: "mark-channel-read",
    label: "Mark Channel Read",
    hint: "Acknowledges the open chat",
    scope: "local",
    defaultAccelerator: null,
  },
];

export type Keybinds = Record<ActionId, string>;

/** "" for the actions that ship unbound — resolveKeybinds fills the rest. */
export const DEFAULT_KEYBINDS: Keybinds = KEYBIND_ACTIONS.reduce((acc, action) => {
  acc[action.id] = action.defaultAccelerator ?? "";
  return acc;
}, {} as Keybinds);

// ---------------------------------------------------------------------------
// Accelerator algebra
// ---------------------------------------------------------------------------

/** Modifier tokens in canonical order (Control+Alt+Shift+Meta, Electron order). */
const MODIFIER_TOKENS = ["Control", "Alt", "Shift", "Meta"] as const;

/** event.code → the Electron key token. Everything not listed is unrecordable. */
const CODE_TO_TOKEN: Record<string, string> = {
  ...Object.fromEntries("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => [`Key${letter}`, letter])),
  ...Object.fromEntries("0123456789".split("").map((digit) => [`Digit${digit}`, digit])),
  ...Object.fromEntries("0123456789".split("").map((digit) => [`Numpad${digit}`, digit])),
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => index + 1).map((functionKey) => [`F${functionKey}`, `F${functionKey}`]),
  ),
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
  Tab: "Tab",
  Enter: "Return",
  NumpadEnter: "Return",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
};

/** Aliases a hand-written/stored token may carry → the canonical one. */
const TOKEN_ALIASES: Record<string, string> = {
  Ctrl: "Control",
  Cmd: "Meta",
  Command: "Meta",
  Super: "Meta",
  // Stored canonically as Control (Windows-first); on a macOS port the main
  // process maps Control → CommandOrControl at the registration boundary only.
  CmdOrCtrl: "Control",
  CommandOrControl: "Control",
  Esc: "Escape",
  Enter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** KeyboardEvent-shaped input (the structural subset — tests pass literals). */
export interface KeyEventShape {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}

/** The canonical accelerator for a keyboard event; null while only modifiers are
 *  held, or the key has no Electron token (unrecordable). */
export function acceleratorFromKeyboardEvent(event: KeyEventShape): string | null {
  const keyToken = CODE_TO_TOKEN[event.code];
  if (keyToken === undefined) {
    return null;
  }
  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }
  return [...modifiers, keyToken].join("+");
}

function isModifierToken(token: string): token is (typeof MODIFIER_TOKENS)[number] {
  return (MODIFIER_TOKENS as readonly string[]).includes(token);
}

function canonicalToken(token: string): string | null {
  const candidate = TOKEN_ALIASES[token] ?? token;
  if (isModifierToken(candidate)) {
    return candidate;
  }
  // A key token is valid if some event.code maps to it (letters, digits, F-keys,
  // named keys, punctuation all do).
  return Object.values(CODE_TO_TOKEN).includes(candidate) ? candidate : null;
}

/** Canonicalizes a stored/hand-written accelerator: aliases resolved, modifiers
 *  reordered to Control/Alt/Shift/Meta, exactly one key token. null = garbage. */
export function normalizeAccelerator(input: string): string | null {
  const parts = input.split("+").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) {
    return null;
  }
  const modifiers = new Set<string>();
  let keyToken: string | null = null;
  for (const part of parts) {
    const canonical = canonicalToken(part);
    if (canonical === null) {
      return null;
    }
    if (isModifierToken(canonical)) {
      modifiers.add(canonical); // a duplicated modifier collapses silently
      continue;
    }
    if (keyToken !== null) {
      return null; // two key tokens is not a chord
    }
    keyToken = canonical;
  }
  if (keyToken === null) {
    return null; // modifiers only
  }
  return [...MODIFIER_TOKENS.filter((modifier) => modifiers.has(modifier)), keyToken].join("+");
}

const DISPLAY_MODIFIERS: Record<string, string> = {
  Control: "Ctrl",
  Meta: "Win",
  Return: "Enter",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** Pretty form for the settings rows: "Ctrl+Shift+M", "Alt+↓". Display only. */
export function formatAccelerator(accelerator: string): string {
  if (accelerator === "") {
    return "Not bound";
  }
  return accelerator
    .split("+")
    .map((token) => DISPLAY_MODIFIERS[token] ?? token)
    .join("+");
}

/** True when the chord has no Ctrl/Alt/Meta — a GLOBAL bind like that steals the
 *  bare key from every application on the machine (allowed, but warned). */
export function isBareKeyAccelerator(accelerator: string): boolean {
  return accelerator !== "" && !accelerator.startsWith("Control") && !accelerator.startsWith("Alt")
    && !accelerator.startsWith("Meta") && accelerator.split("+").length === 1;
}

// ---------------------------------------------------------------------------
// Resolution, conflicts, sync payload
// ---------------------------------------------------------------------------

/** defaults ⊕ stored: missing actions get their defaults, an explicit "" stays
 *  unbound, a garbage value falls back to the default, unknown ids are dropped
 *  (forward compat — the same sanitize pattern the NS engine catalog uses). */
export function resolveKeybinds(stored: Partial<Record<ActionId, string>>): Keybinds {
  const resolved = { ...DEFAULT_KEYBINDS };
  for (const action of KEYBIND_ACTIONS) {
    const value = stored[action.id];
    if (value === undefined) {
      continue;
    }
    if (value === "") {
      resolved[action.id] = "";
      continue;
    }
    const normalized = normalizeAccelerator(value);
    resolved[action.id] = normalized ?? resolved[action.id];
  }
  return resolved;
}

/** accelerator → the actions bound to it, ONLY where more than one action claims
 *  it (a local + global duplicate counts — both paths would fire at once). */
export function findAcceleratorConflicts(bindings: Keybinds): Map<string, ActionId[]> {
  const byAccelerator = new Map<string, ActionId[]>();
  for (const action of KEYBIND_ACTIONS) {
    const accelerator = bindings[action.id];
    if (accelerator === "") {
      continue;
    }
    const holders = byAccelerator.get(accelerator) ?? [];
    holders.push(action.id);
    byAccelerator.set(accelerator, holders);
  }
  return new Map([...byAccelerator.entries()].filter(([, holders]) => holders.length > 1));
}

/** The deterministic sync payload for the main process: global-scope, non-empty,
 *  sorted by id (identical settings serialize identically — the change detector
 *  in the runtime compares the JSON of this). */
export function globalBindingsForSync(bindings: Keybinds): { id: ActionId; accelerator: string }[] {
  return KEYBIND_ACTIONS
    .filter((action) => action.scope === "global" && bindings[action.id] !== "")
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((action) => ({ id: action.id, accelerator: bindings[action.id] }));
}

// ---------------------------------------------------------------------------
// Dispatcher helpers
// ---------------------------------------------------------------------------

/** The call machine's states (mirrors runtime's AppState.callState union — the
 *  structural copy keeps this module importable in node tests). */
export type CallLifecycleState = "idle" | "ringing-out" | "ringing-in" | "connecting" | "in-call";

/** Which voice surface owns the mic toggles right now. A call beats the room
 *  (oak: the call is the exclusive surface) — but only once it has a mic: while
 *  a call merely RINGS IN, the room keeps the mic, and with no room either there
 *  is nothing to toggle ("none"). */
export function voiceSurfaceFor(state: {
  callState: CallLifecycleState | string;
  activeVoiceChannelId: number | null;
}): "call" | "room" | "none" {
  if (state.callState === "ringing-out" || state.callState === "connecting" || state.callState === "in-call") {
    return "call";
  }
  if (state.activeVoiceChannelId !== null) {
    return "room";
  }
  return "none";
}

/** One step through the TEXT channels (sidebar order); null at the edges or when
 *  the current channel is not in the list. VOICE channels and unknown ids are
 *  skipped (a keyboard walk through text chats is the Discord behavior). */
export function adjacentChannelId(
  channels: readonly { id: number; type: string }[],
  currentId: number | null,
  delta: 1 | -1,
): number | null {
  const textChannelIds = channels.filter((channel) => channel.type === "TEXT").map((channel) => channel.id);
  if (textChannelIds.length === 0) {
    return null;
  }
  if (currentId === null) {
    return delta === 1 ? textChannelIds[0]! : textChannelIds[textChannelIds.length - 1]!;
  }
  const index = textChannelIds.indexOf(currentId);
  if (index === -1) {
    return null;
  }
  const next = textChannelIds[index + delta];
  return next ?? null;
}
