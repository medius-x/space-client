import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore";
import { keybindStatusStore, resumeGlobalHotkeys, settingsStore, suspendGlobalHotkeys } from "../runtime";
import { Modal } from "./Modal";
import {
  acceleratorFromKeyboardEvent,
  DEFAULT_KEYBINDS,
  formatAccelerator,
  isBareKeyAccelerator,
  KEYBIND_ACTIONS,
  normalizeAccelerator,
  resolveKeybinds,
  type ActionId,
  type KeybindAction,
  type Keybinds,
} from "../../domain/logic/keybinds";

/**
 * Keybinds (2026-09-18) — INSTANT-apply with a per-row confirmation (user
 * decision: no window-level Apply here). Recording a chord stages it as a
 * pending value shown IN the pill; two small square buttons float over the
 * pill's right edge — ✓ commits the chord through the settings store (the OS
 * re-registration rides the settings subscription), ✕ rolls the pill back.
 *
 * The recording state lives HERE, not in the recorder buttons: exactly ONE row
 * records at a time (live report: two pills clicked in sequence both listened,
 * and the first swallowed every chord until it had one of its own). A click
 * anywhere outside a pill cancels the recording. While a recording is LIVE the
 * app's own OS chord registrations are suspended ({@link suspendGlobalHotkeys}):
 * a registered chord is swallowed by the OS before it ever reaches this window,
 * so without the suspend the recorder cannot even hear our own defaults. A
 * chord that duplicates another action is REFUSED at record time with a popup
 * naming the holder. Escape cancels the RECORDING (never records an Escape
 * chord, never closes the modal), Backspace stages an unbind, bare modifier
 * holds are ignored.
 *
 * Global chords register OS-wide (they fire from an unfocused game — the reason
 * this feature exists); in-app chords match only while the window is focused.
 */

/** A chord recorded but not yet confirmed for one action ("" = staged unbind). */
interface PendingBinding {
  actionId: ActionId;
  chord: string;
}

/** A refused chord: the popup names the action that already owns it. */
interface ConflictNotice {
  actionId: ActionId;
  chord: string;
  holderLabel: string;
}

/** The recorder pill — purely presentational: the section owns recording. */
function KeybindRecorder({ shownChord, recording, pending, conflictNotice, onToggleRecord, onConfirm, onRevert }: {
  shownChord: string;
  recording: boolean;
  pending: PendingBinding | null;
  conflictNotice: ConflictNotice | null;
  onToggleRecord(): void;
  onConfirm(): void;
  onRevert(): void;
}): React.JSX.Element {
  const bound = shownChord !== "";
  return (
    <div className="keybind-recorder-wrap">
      <button
        className={"keybind-recorder" + (recording ? " recording" : "") + (pending !== null ? " pending" : "")}
        onClick={onToggleRecord}
        title={recording ? "Recording… (Escape cancels, Backspace unbinds)" : bound ? "Click to re-record" : "Click to bind"}
      >
        {recording ? "Press keys…" : formatAccelerator(shownChord)}
      </button>
      {pending !== null ? (
        <span className="keybind-confirm">
          <button className="keybind-confirm-accept" title="Save this binding" onClick={onConfirm}>
            <span className="icon mdi-check" />
          </button>
          <button className="keybind-confirm-cancel" title="Keep the previous binding" onClick={onRevert}>
            <span className="icon mdi-close" />
          </button>
        </span>
      ) : null}
      {conflictNotice !== null ? (
        <span className="keybind-conflict-popup">
          {formatAccelerator(conflictNotice.chord)} is already bound to {conflictNotice.holderLabel}
        </span>
      ) : null}
    </div>
  );
}

function KeybindRow({ action, shownChord, recording, conflictHolders, pending, conflictNotice, onToggleRecord, onConfirm, onRevert, onReset }: {
  action: KeybindAction;
  shownChord: string;
  recording: boolean;
  conflictHolders: ActionId[] | undefined;
  pending: PendingBinding | null;
  conflictNotice: ConflictNotice | null;
  onToggleRecord(): void;
  onConfirm(): void;
  onRevert(): void;
  onReset(): void;
}): React.JSX.Element {
  const status = useStore(keybindStatusStore, (snapshot) => snapshot[action.id] ?? null);
  const isDefault = shownChord === (action.defaultAccelerator ?? "");
  return (
    <div className="keybind-row">
      <div className="keybind-label">
        <span>{action.label}</span>
        <span className="keybind-hint">{action.hint}</span>
        {conflictHolders !== undefined && shownChord !== "" ? (
          <span className="keybind-badge warn">
            Also used by {conflictHolders.filter((holder) => holder !== action.id)
              .map((holder) => KEYBIND_ACTIONS.find((candidate) => candidate.id === holder)?.label ?? holder)
              .join(", ")}
          </span>
        ) : null}
        {action.scope === "global" && isBareKeyAccelerator(shownChord) ? (
          <span className="keybind-badge warn">
            A single key takes it from every application — add Ctrl, Alt or Shift
          </span>
        ) : null}
        {action.scope === "global" && status === "taken" ? (
          <span className="keybind-badge warn">In use by another application</span>
        ) : null}
      </div>
      <KeybindRecorder
        shownChord={shownChord}
        recording={recording}
        pending={pending}
        conflictNotice={conflictNotice}
        onToggleRecord={onToggleRecord}
        onConfirm={onConfirm}
        onRevert={onRevert}
      />
      {/* Always present (row alignment — live request), disabled while the shown
          value IS the default. Disabled state = "nothing to restore". */}
      <button className="keybind-reset" title="Reset to the default binding" disabled={isDefault} onClick={onReset}>
        <span className="icon mdi-refresh" />
      </button>
    </div>
  );
}

export function KeybindsSection(): React.JSX.Element {
  const stored = useStore(settingsStore, (snapshot) => snapshot.keybinds);
  const bindings = resolveKeybinds(stored);
  const [pending, setPending] = useState<PendingBinding | null>(null);
  const [conflictNotice, setConflictNotice] = useState<ConflictNotice | null>(null);
  /** THE recording row — one at a time, owned here (live report: per-button
   *  state left two pills listening at once, the first swallowing every chord). */
  const [recordingId, setRecordingId] = useState<ActionId | null>(null);
  /** The section-wide reset awaits its own confirmation (user decision); the
   *  per-row reset does NOT — its staged value already has the ✓/✕ pair. */
  const [resetAllOpen, setResetAllOpen] = useState(false);

  const recording = recordingId !== null;

  // Suspend the app's own OS chords for the WHOLE recording session (one
  // suspend even when the user hops from pill to pill).
  useEffect(() => {
    if (!recording) {
      return;
    }
    suspendGlobalHotkeys();
    return () => resumeGlobalHotkeys();
  }, [recording]);

  // The chord sink — the only keydown listener while a recording is live.
  useEffect(() => {
    if (recordingId === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Capture phase with an immediate stop: the chord being recorded must not
      // leak into the app (the modal's Escape-close, the composer, local binds).
      event.preventDefault();
      event.stopImmediatePropagation();
      const actionId = recordingId;
      if (event.code === "Escape") {
        setRecordingId(null); // cancel — an Escape chord is not recordable (Discord)
        return;
      }
      if (event.code === "Backspace") {
        setRecordingId(null);
        record(actionId, ""); // stage an unbind
        return;
      }
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (accelerator === null) {
        return; // bare modifier hold — keep listening
      }
      setRecordingId(null);
      record(actionId, accelerator);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    // `bindings` re-subscribes the listener when a commit changes the set — the
    // `record` closure below must always see the fresh bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, bindings]);

  // A click outside any pill cancels the recording (live request: clicking away
  // must clear the "Press keys…" state, not leave the pill armed).
  useEffect(() => {
    if (recordingId === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".keybind-recorder") === null) {
        setRecordingId(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [recordingId]);

  /** A recorded chord is refused when another action already owns it — the
   *  popup names the holder (a duplicate across scopes would double-fire). */
  const record = (actionId: ActionId, chord: string): void => {
    const action = KEYBIND_ACTIONS.find((candidate) => candidate.id === actionId);
    if (action === undefined) {
      return;
    }
    if (chord !== "") {
      const holder = KEYBIND_ACTIONS.find((other) => other.id !== actionId && bindings[other.id] === chord);
      if (holder !== undefined) {
        setConflictNotice({ actionId, chord, holderLabel: holder.label });
        return;
      }
    }
    setConflictNotice(null);
    setPending({ actionId, chord });
  };

  const revert = (): void => {
    setPending(null);
    setConflictNotice(null);
  };

  const commit = (actionId: ActionId, chord: string): void => {
    const value = chord === "" ? "" : normalizeAccelerator(chord);
    if (value === null) {
      return; // a foreign chord that does not normalize — keep the previous one
    }
    settingsStore.apply({ keybinds: { ...resolveKeybinds(settingsStore.getSnapshot().keybinds), [actionId]: value } });
    setPending(null);
    setConflictNotice(null);
  };

  const shownChordFor = (action: KeybindAction): string =>
    pending !== null && pending.actionId === action.id ? pending.chord : bindings[action.id];

  const renderRow = (action: KeybindAction): React.JSX.Element => {
    const shownChord = shownChordFor(action);
    // The live conflict set covers every action's SHOWN chord — a pending chord
    // warns on the OTHER row it now duplicates.
    const conflictHolders = KEYBIND_ACTIONS
      .filter((other) => shownChordFor(other) === shownChord && shownChord !== "")
      .map((other) => other.id);
    return (
      <KeybindRow
        key={action.id}
        action={action}
        shownChord={shownChord}
        recording={recordingId === action.id}
        conflictHolders={conflictHolders.length > 1 ? conflictHolders : undefined}
        pending={pending !== null && pending.actionId === action.id ? pending : null}
        conflictNotice={conflictNotice !== null && conflictNotice.actionId === action.id ? conflictNotice : null}
        onToggleRecord={() => {
          revert(); // starting a new recording drops an unconfirmed one
          setRecordingId(recordingId === action.id ? null : action.id);
        }}
        onConfirm={() => commit(action.id, pending?.chord ?? bindings[action.id])}
        onRevert={revert}
        onReset={() => {
          setConflictNotice(null);
          setPending({ actionId: action.id, chord: action.defaultAccelerator ?? "" });
        }}
      />
    );
  };

  const globalActions = KEYBIND_ACTIONS.filter((action) => action.scope === "global");
  const localActions = KEYBIND_ACTIONS.filter((action) => action.scope === "local");
  return (
    <div>
      <h3>Global</h3>
      <div className="settings-hint">
        These work even when the window is not focused — mute yourself from a game.
        The chords are registered with the operating system; a chord another
        application already owns is badged and will not fire.
      </div>
      {globalActions.map(renderRow)}
      <h3>In-app</h3>
      <div className="settings-hint">
        These fire while the window is focused. A bare key stays plain typing inside
        the message composer; chords with Ctrl, Alt or Win fire everywhere.
      </div>
      {localActions.map(renderRow)}
      {/* Right-aligned WITH the rows: the row list is capped at 560px, so the
          button's container takes the same cap — its right edge lines up with
          the per-row reset pills instead of the settings pane's edge. */}
      <div className="keybind-reset-all-row">
        <button className="keybind-reset-all" onClick={() => setResetAllOpen(true)}>
          Reset all keybinds
        </button>
      </div>
      {resetAllOpen ? (
        <Modal title="Reset all keybinds" onClose={() => setResetAllOpen(false)}>
          <div className="modal-note">
            Reset every binding — global and in-app — back to its default?
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setResetAllOpen(false)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                setPending(null);
                setConflictNotice(null);
                settingsStore.apply({ keybinds: { ...DEFAULT_KEYBINDS } });
                setResetAllOpen(false);
              }}
            >
              Reset
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
