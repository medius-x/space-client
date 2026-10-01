import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { joinVoiceGuarded, setActiveChannel } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Channel } from "../../types";
import { Modal } from "./Modal";

/** The AFK-timeout presets (5 minutes..7 days, Discord's span). */
export const AFK_TIMEOUT_PRESETS: readonly { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "7 days" },
];

/**
 * The channel-creation dialog — shared by the Sidebar's "+" (the channel panel) and
 * Server Settings → Channels' header "+" (the Roles idiom). Kinds: text / voice /
 * category (the Category tab hides when opened from INSIDE a category — nested
 * categories do not exist). A VOICE channel may be born as the server's AFK room: the
 * "AFK channel" toggle reveals the idle-timeout picker, and the submit designates the
 * fresh room via PUT /api/server/afk (one AFK channel per server — the server replaces
 * any previous one).
 */
export function CreateChannelModal({ session, request, categories, onClose }: {
  session: ConnectionSession;
  request: { kind: "TEXT" | "VOICE" | "CATEGORY"; parentId: number | null; inCategory: boolean };
  categories: readonly Channel[];
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"TEXT" | "VOICE" | "CATEGORY">(request.kind);
  // The parent select: the pre-selected category (from the header "+") or None.
  const [parentId, setParentId] = useState<number | null>(
    request.kind === "TEXT" || request.kind === "VOICE" ? request.parentId : null);
  // The AFK toggle (VOICE only): born as the idle-sweep room with its timeout.
  const [afk, setAfk] = useState(false);
  const [afkTimeoutMinutes, setAfkTimeoutMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const channel = await session.createChannel(
        kind === "CATEGORY"
          ? { name: trimmed, type: "CATEGORY" }
          : { name: trimmed, type: kind, parentId });
      if (afk && kind === "VOICE") {
        // Designate the fresh room as THE AFK channel (the server replaces any previous
        // one). A failure here leaves the channel alive, just not AFK — surfaced inline.
        await session.rest.updateAfkSettings(channel.id, afkTimeoutMinutes);
      }
      onClose();
      // oak opens the fresh channel right away: text → the chat, voice → a join.
      // A category stays closed — there is nothing to open.
      if (channel.type === "VOICE") {
        joinVoiceGuarded(channel);
      } else if (channel.type === "TEXT") {
        setActiveChannel(channel.id);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={kind === "CATEGORY" ? "Create category" : "Create channel"} onClose={onClose}>
      <div className="modal-row">
        <label className={"kind-choice" + (kind === "TEXT" ? " chosen" : "")} onClick={() => setKind("TEXT")}><span className="icon mdi-pound" /> text</label>
        <label className={"kind-choice" + (kind === "VOICE" ? " chosen" : "")} onClick={() => setKind("VOICE")}><span className="icon mdi-volume-high" /> voice</label>
        {/* Nested categories do not exist — the category's own "+" offers only
            channels (user decision). */}
        {!request.inCategory ? (
          <label className={"kind-choice" + (kind === "CATEGORY" ? " chosen" : "")} onClick={() => setKind("CATEGORY")}><span className="icon mdi-folder-outline" /> category</label>
        ) : null}
      </div>
      {kind !== "CATEGORY" ? (
        <label className="settings-field">
          <span>Category</span>
          <select value={parentId === null ? "" : parentId} onChange={(event) =>
            setParentId(event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">— no category —</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>
      ) : null}
      {kind === "VOICE" ? (
        <div className="settings-check">
          <input
            type="checkbox"
            id="create-afk-toggle"
            checked={afk}
            onChange={(event) => setAfk(event.target.checked)}
          />
          <label htmlFor="create-afk-toggle">AFK channel — idle members are moved here</label>
        </div>
      ) : null}
      {kind === "VOICE" && afk ? (
        <label className="settings-field">
          <span>AFK timeout</span>
          <select value={afkTimeoutMinutes} onChange={(event) => setAfkTimeoutMinutes(Number(event.target.value))}>
            {AFK_TIMEOUT_PRESETS.map((preset) => (
              <option key={preset.minutes} value={preset.minutes}>{preset.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
        placeholder={kind === "TEXT" ? "new-channel" : kind === "VOICE" ? "General Voice" : "New Category"}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || name.trim().length === 0} onClick={() => void submit()}>Create</button>
      </div>
    </Modal>
  );
}
