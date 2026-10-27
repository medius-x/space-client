import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { joinVoiceGuarded, setActiveChannel } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Channel } from "../../types";
import type { Translator } from "../../domain/i18n/i18n";
import { useT } from "../hooks/useT";
import { Modal } from "./Modal";

/** The AFK-timeout presets (5 minutes..7 days, Discord's span). Bare minute
 *  counts — the label is localized at render time by {@link afkTimeoutLabel}. */
export const AFK_TIMEOUT_PRESETS: readonly number[] = [5, 15, 30, 60, 240, 1440, 10080];

/** The human label of an AFK-timeout preset (days > hours > minutes granularity). */
export function afkTimeoutLabel(t: Translator, minutes: number): string {
  if (minutes % 1440 === 0) {
    return t("afkPreset.days", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return t("afkPreset.hours", { count: minutes / 60 });
  }
  return t("afkPreset.minutes", { count: minutes });
}

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
  const t = useT();
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
    <Modal title={kind === "CATEGORY" ? t("channel.createCategory") : t("sidebar.createChannel")} onClose={onClose}>
      <div className="modal-row">
        <label className={"kind-choice" + (kind === "TEXT" ? " chosen" : "")} onClick={() => setKind("TEXT")}><span className="icon mdi-pound" /> {t("channel.kind.text")}</label>
        <label className={"kind-choice" + (kind === "VOICE" ? " chosen" : "")} onClick={() => setKind("VOICE")}><span className="icon mdi-volume-high" /> {t("channel.kind.voice")}</label>
        {/* Nested categories do not exist — the category's own "+" offers only
            channels (user decision). */}
        {!request.inCategory ? (
          <label className={"kind-choice" + (kind === "CATEGORY" ? " chosen" : "")} onClick={() => setKind("CATEGORY")}><span className="icon mdi-folder-outline" /> {t("channel.kind.category")}</label>
        ) : null}
      </div>
      {kind !== "CATEGORY" ? (
        <label className="settings-field">
          <span>{t("channel.categoryLabel")}</span>
          <select value={parentId === null ? "" : parentId} onChange={(event) =>
            setParentId(event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">{t("channel.noCategory")}</option>
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
          <label htmlFor="create-afk-toggle">{t("channel.afkToggle")}</label>
        </div>
      ) : null}
      {kind === "VOICE" && afk ? (
        <label className="settings-field">
          <span>{t("serverSettings.afkTimeout")}</span>
          <select value={afkTimeoutMinutes} onChange={(event) => setAfkTimeoutMinutes(Number(event.target.value))}>
            {AFK_TIMEOUT_PRESETS.map((presetMinutes) => (
              <option key={presetMinutes} value={presetMinutes}>{afkTimeoutLabel(t, presetMinutes)}</option>
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
        placeholder={kind === "TEXT" ? t("channel.placeholderText") : kind === "VOICE" ? t("channel.placeholderVoice") : t("channel.placeholderCategory")}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary" disabled={busy || name.trim().length === 0} onClick={() => void submit()}>{t("common.create")}</button>
      </div>
    </Modal>
  );
}
