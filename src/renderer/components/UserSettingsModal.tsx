import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  changeAccountPassword,
  changeAccountUsername,
  connectionDirectory,
  inVoiceOrCall,
  manualUpdateCheck,
  proceedUpdateDownload,
  roomAudio,
  settingsStore,
  toggleUserSettings,
  updateInterruptsMedia,
  updateNotificationPrefs,
} from "../runtime";
import { notifications } from "../notifications";
import { ApiError } from "../../core/rest";
import type { ClientSettings } from "../../domain/stores/SettingsStore";
import type { LanguageSetting } from "../../domain/i18n/i18n";
import { advertisedAddress, DISK_CACHE_CHOICES, diskCacheLabel } from "../../domain/logic/settings-format";
import { JUMBO_EMOJI_DEFAULT_PX, JUMBO_EMOJI_MAX_PX, JUMBO_EMOJI_MIN_PX } from "../../domain/logic/emoji-picker";
import { deviceLabelFor, matchDeviceId } from "../../domain/logic/device-match";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { DEFAULT_NOTIFICATION_PREFS } from "../../domain/session/connection-record";
import { CHANGE_NICKNAME_PERMISSION, type NotificationPrefs } from "../../types";
import { useDisplayName } from "../hooks/useDisplayName";
import { useT } from "../hooks/useT";
import { downloadClientLogs } from "../logs-export";
import { Modal } from "./Modal";
import { nsEngineDescription, nsEngineLabel } from "./VoiceRoom";
import { Avatar } from "./Avatar";
import { AvatarEditor, userAvatarApi } from "./ProfileModal";
import { KeybindsSection } from "./KeybindsSection";
import { PasswordInput } from "./PasswordInput";

/**
 * User settings — oak's SettingsWindow. The sections split by SCOPE (user
 * decision): General (avatar + nickname) and Account (password/login) are
 * SERVER-related — they edit THIS instance's account, and the panel heading
 * carries " — {server name}" for them; Audio/Video/Appearance/Notifications/
 * Diagnostics are CLIENT-related (one set for every server). oak's STAGED
 * model for the client sections: the controls write a draft in memory, the
 * window-level Apply button commits, leaving the section (or closing the
 * window) without Apply discards. General/Account/Diagnostics are immediate
 * (oak parity — their buttons act directly).
 */

type Section = "general" | "account" | "audio" | "video" | "keybinds" | "appearance" | "notifications" | "diagnostics";

/** The nav labels resolve through the dictionary at render time (the localization
 *  round): a module-level string map would freeze the language. */
const SECTION_LABEL_KEYS: Record<Section, "settings.section.general" | "settings.section.account" | "settings.section.audio" | "settings.section.video" | "settings.section.keybinds" | "settings.section.appearance" | "settings.section.notifications" | "settings.section.diagnostics"> = {
  general: "settings.section.general",
  account: "settings.section.account",
  audio: "settings.section.audio",
  video: "settings.section.video",
  keybinds: "settings.section.keybinds",
  appearance: "settings.section.appearance",
  notifications: "settings.section.notifications",
  diagnostics: "settings.section.diagnostics",
};

const SECTIONS: { key: Section }[] = [
  { key: "general" },
  { key: "account" },
  { key: "audio" },
  { key: "video" },
  { key: "keybinds" },
  { key: "appearance" },
  { key: "notifications" },
  { key: "diagnostics" },
];

/** The sections that stage their edits behind the window-level Apply button.
 *  Keybinds is deliberately NOT here: it applies per binding with its own
 *  ✓/✕ confirmation over the recorder pill (user decision 2026-09-18). */
const STAGED_SECTIONS: ReadonlySet<Section> = new Set(["audio", "video", "appearance", "notifications"]);

/** The SERVER-related sections: the panel heading appends " — {server name}"
 *  so the scope is visible right in the chrome (user decision). They are also
 *  the ACCOUNT scope's whole section list (user decision 2026-09-21): the
 *  server header's dropdown opens these two as "Account settings", the ⚙
 *  button opens the client-side remainder. "general" lives in BOTH scopes
 *  with different content (2026-10-19): the client scope's front tab carries
 *  the downloads folder and the disk cache, the account scope keeps the
 *  server identity (avatar + nickname). */
const SERVER_SCOPED_SECTIONS: ReadonlySet<Section> = new Set(["general", "account"]);
/** Sections the ACCOUNT scope shows (the dropdown entry). */
const ACCOUNT_SCOPE_SECTIONS: ReadonlySet<Section> = new Set(["general", "account"]);

/** oak's pane heading — the same chrome Server Settings sections carry. */
function SectionHeading({ title }: { title: string }): React.JSX.Element {
  return <div className="roles-list-header overview-heading"><span>{title}</span></div>;
}

export function UserSettingsModal({ session }: { session: ConnectionSession | null }): React.JSX.Element {
  const t = useT();
  const scope = useStore(appStore, (state) => state.userSettingsScope);
  const visibleSections = SECTIONS.filter((entry) =>
    scope === "account" ? ACCOUNT_SCOPE_SECTIONS.has(entry.key) : entry.key !== "account");
  const [section, setSection] = useState<Section>(visibleSections[0]!.key);
  // Defensive: a scope switch under a mounted modal would leave an invisible
  // section selected — fall back to the scope's first entry.
  const activeSection = visibleSections.some((entry) => entry.key === section) ? section : visibleSections[0]!.key;
  const staged = useStagedSettings(session);
  // A null session (no server AT ALL — a fresh install) reaches here only in
  // the CLIENT scope: the empty user bar's gear opens it (user report #1),
  // keeping audio, keybinds and the diagnostics/log export reachable. The
  // server-scoped sections are filtered out above and never mount on null.
  const serverName = useStore(connectionDirectory, (records) =>
    session !== null
      ? records.find((entry) => entry.id === session.recordId)?.cachedServerName ?? session.hostUrl()
      : "");
  const sectionLabel = SECTIONS.find((entry) => entry.key === activeSection) !== undefined
    ? t(SECTION_LABEL_KEYS[activeSection])
    : "";
  const headingTitle = scope === "account" && SERVER_SCOPED_SECTIONS.has(activeSection)
    ? `${sectionLabel} — ${serverName}`
    : sectionLabel;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        toggleUserSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // oak: leaving a staged section without Apply DISCARDS the draft — the next
  // visit rebuilds the pane from the stored settings.
  const selectSection = (key: Section): void => {
    staged.discard();
    setSection(key);
  };

  return (
    <div className="settings-screen">
      <div className="settings-nav">
        <div className="settings-nav-title">{scope === "account" ? t("settings.accountSettingsTitle") : t("settings.userSettingsTitle")}</div>
        {visibleSections.map((entry) => (
          <button
            key={entry.key}
            className={"settings-nav-item" + (entry.key === activeSection ? " active" : "")}
            onClick={() => selectSection(entry.key)}
          >
            {t(SECTION_LABEL_KEYS[entry.key])}
          </button>
        ))}
      </div>
      {/* Keybinds owns its scroll (the Roles idiom): the body stops scrolling,
          the page heading and the section's reset row stay pinned and only the
          row list scrolls (user request 2026-10-07). */}
      <div className={"settings-body" + (activeSection === "keybinds" ? " keybinds-pinned" : "")}>
        <SectionHeading title={headingTitle} />
        {activeSection === "general"
          ? (scope === "account"
            ? (session !== null ? <GeneralSection session={session} /> : null)
            : <GeneralClientSection session={session} />)
          : null}
        {activeSection === "account" && session !== null ? <AccountSection session={session} /> : null}
        {activeSection === "audio" ? <AudioSection staged={staged} /> : null}
        {activeSection === "video" ? <VideoSection staged={staged} /> : null}
        {activeSection === "keybinds" ? <KeybindsSection /> : null}
        {activeSection === "appearance" ? <AppearanceSection staged={staged} /> : null}
        {activeSection === "notifications" ? <NotificationsSection session={session} staged={staged} /> : null}
        {activeSection === "diagnostics" ? <DiagnosticsSection session={session} /> : null}
        {/* The Apply button hugs the section content (staged sections only) and
            commits the draft; leaving the section without it discards. */}
        {STAGED_SECTIONS.has(activeSection) ? (
          <div className="modal-actions left settings-apply">
            <button className="primary" disabled={!staged.changed} onClick={staged.commit}>{t("settings.apply")}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The staged draft (oak's syncControls/applyButton wiring, React shape)
// ---------------------------------------------------------------------------

export interface StagedSettings {
  /** The draft value of a setting: the staged override, else the stored one. */
  value<K extends keyof ClientSettings>(key: K): ClientSettings[K];
  set<K extends keyof ClientSettings>(key: K, next: ClientSettings[K]): void;
  /** A draft entry still differs from the stored value (per-section warnings). */
  differs(key: keyof ClientSettings): boolean;
  /** Anything staged (settings or the per-server notification override) differs — Apply's gate. */
  changed: boolean;
  /** The per-server notification override staged alongside the globals (Notifications). */
  notif: NotificationPrefs | null;
  setNotif(prefs: NotificationPrefs): void;
  /** Write everything through and run the live effects (oak's onApplied). */
  commit(): void;
  discard(): void;
}

function useStagedSettings(session: ConnectionSession | null): StagedSettings {
  const [draft, setDraft] = useState<Partial<ClientSettings>>({});
  const [notifDraft, setNotifDraft] = useState<NotificationPrefs | null>(null);
  const stored = useStore(settingsStore, (snapshot) => snapshot);
  const storedNotif = useStore(connectionDirectory, (records) =>
    (session !== null
      ? records.find((entry) => entry.id === session.recordId)?.notifPrefs
      : undefined) ?? DEFAULT_NOTIFICATION_PREFS);

  const value = <K extends keyof ClientSettings>(key: K): ClientSettings[K] =>
    (key in draft ? draft[key] : stored[key]) as ClientSettings[K];

  const set = <K extends keyof ClientSettings>(key: K, next: ClientSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: next }));
  };

  const differs = (key: keyof ClientSettings): boolean =>
    key in draft && draft[key] !== stored[key];

  const notifChanged = notifDraft !== null
    && (notifDraft.mode !== storedNotif.mode || notifDraft.suppressEveryoneHere !== storedNotif.suppressEveryoneHere);
  const changed = notifChanged || (Object.keys(draft) as (keyof ClientSettings)[]).some((key) => differs(key));

  const commit = (): void => {
    const applied = draft;
    setDraft({});
    if (Object.keys(applied).length > 0) {
      settingsStore.apply(applied);
      // The live effects ride the COMMIT, not the clicks (oak's onApplied): the
      // speaker re-points the playout graph now; the cache budget trims/wipes now.
      if (applied.speakerDeviceId !== undefined) {
        roomAudio.setOutputDevice(applied.speakerDeviceId);
        notifications.setOutputDevice(applied.speakerDeviceId); // UI sounds follow the chosen speaker (oak's playout line)
      }
      if (applied.imageCacheMegabytes !== undefined && session !== null) {
        session.attachmentCache.setDiskBudget(applied.imageCacheMegabytes * 1024 * 1024); // 0 purges the disk layer
      }
    }
    const stagedNotif = notifDraft;
    setNotifDraft(null);
    if (stagedNotif !== null && session !== null) {
      void updateNotificationPrefs(session.recordId, stagedNotif); // no session — a local draft only
    }
  };

  const discard = (): void => {
    setDraft({});
    setNotifDraft(null);
  };

  return { value, set, differs, changed, notif: notifDraft, setNotif: setNotifDraft, commit, discard };
}

// ---------------------------------------------------------------------------
// General — the avatar + the nickname, in the Server Settings → Overview idiom
// ---------------------------------------------------------------------------

function GeneralSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  // The rename model: what General shows is the NICKNAME (the name people see);
  // the login never surfaces here.
  const ownDisplayName = useDisplayName(session, ownUsername);
  const canChangeNickname = useStore(session.permissionStore, (state) =>
    state.my?.permissions.includes(CHANGE_NICKNAME_PERMISSION) ?? false);
  return (
    <div>
      {/* Overview idiom: the identity name rides under the heading in the
          role-editor typography — no pencil, the nickname edits below. */}
      <div className="role-editor-title-row">
        <span className="role-editor-name">{ownDisplayName}</span>
      </div>
      <AvatarEditor
        session={session}
        api={userAvatarApi(session)}
        preview={<Avatar session={session} username={ownUsername} size={96} />}
        stacked
        removeTitle={t("settings.removeAvatarTitle")}
        removeNote={t("settings.removeAvatarNote")}
      />
      {canChangeNickname ? (
        <>
          <h3>{t("settings.nicknameHeader")}</h3>
          <div className="settings-hint">{t("settings.nicknameHint")}</div>
          <NicknameForm session={session} current={ownDisplayName} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices (oak Audio/Video pickers over enumerateDevices)
// ---------------------------------------------------------------------------

/** One "System default + every device" row; labels may be blank before the
 *  first capture grant (Chromium hides them without permission). The DISPLAYED
 *  value re-resolves the saved pick (id first, label fallback — the id hashes
 *  do not survive app restarts, see device-match.ts). */
function DeviceSelect({ label, kind, deviceId, deviceLabel, onChange }: {
  label: string;
  kind: MediaDeviceKind;
  deviceId: string | null;
  deviceLabel: string | null;
  onChange(deviceId: string | null, deviceLabel: string | null): void;
}): React.JSX.Element {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const refresh = (): void => {
      void navigator.mediaDevices.enumerateDevices().then((all) => {
        setDevices(all.filter((device) => device.kind === kind));
      }).catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [kind]);
  const rowLabel = (device: MediaDeviceInfo): string =>
    device.label.length > 0 ? device.label : `${kind} ${device.deviceId.slice(-6)}`;
  const displayValue = matchDeviceId(devices, deviceId, deviceLabel) ?? "";
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select
        value={displayValue}
        onChange={(event) => {
          const next = event.target.value === "" ? null : event.target.value;
          onChange(next, deviceLabelFor(devices, next));
        }}
      >
        <option value="">{t("settings.systemDefault")}</option>
        {/* Chromium prepends SYNTHETIC alias rows ("Default - X" / "Communications - X",
            deviceIds "default"/"communications") that point at the same hardware as
            our System default + the real device below — hide them (oak hid the
            Windows "Primary Sound Driver" mapper for the same reason). */}
        {devices.filter((device) => device.deviceId !== "default" && device.deviceId !== "communications").map((device) => (
          <option key={device.deviceId} value={device.deviceId}>{rowLabel(device)}</option>
        ))}
      </select>
    </label>
  );
}

function AudioSection({ staged }: { staged: StagedSettings }): React.JSX.Element {
  const t = useT();
  const devicesChanged = staged.differs("microphoneDeviceId")
    || staged.differs("speakerDeviceId");
  return (
    <div>
      <h3>{t("settings.nsHeader")}</h3>
      <label className="settings-field"><span>{t("settings.nsEngineLabel")}</span>
        <select
          value={staged.value("noiseSuppressionEngine")}
          onChange={(event) => staged.set("noiseSuppressionEngine", event.target.value as ClientSettings["noiseSuppressionEngine"])}
        >
          <option value="rnnoise">RNNoise</option>
          <option value="deepfilternet3">DeepFilterNet3</option>
          <option value="dtln">DTLN</option>
          <option value="speex">Speex</option>
          <option value="gate">Gate</option>
          <option value="off">{t("nsEngine.off.label")}</option>
        </select>
      </label>
      {/* The selected engine's one-liner (user request 2026-10-27) — the same
          text the selector card shows on hover, so the choice is informed in
          both places. */}
      <div className="settings-hint">
        {nsEngineLabel(t, staged.value("noiseSuppressionEngine"))} — {" "}
        {nsEngineDescription(t, staged.value("noiseSuppressionEngine"))}
      </div>
      {/* DFN3 only — its native knob has a hard 0..100 ceiling, so a SLIDER
          (user decision), never a free-form number field. */}
      {staged.value("noiseSuppressionEngine") === "deepfilternet3" ? (
        <label className="settings-field">
          <span>{t("settings.suppressionLimit", { level: staged.value("deepFilterSuppressionLevel") })}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={staged.value("deepFilterSuppressionLevel")}
            onChange={(event) => staged.set("deepFilterSuppressionLevel", Number(event.target.value))}
          />
        </label>
      ) : null}
      <div className="settings-hint">
        {t("settings.nsHint")}
        {staged.value("noiseSuppressionEngine") === "deepfilternet3"
          ? ` ${t("settings.nsLimitHint")}`
          : ""}
      </div>
      <h3>{t("settings.devicesHeader")}</h3>
      <DeviceSelect
        label={t("settings.microphoneLabelField")}
        kind="audioinput"
        deviceId={staged.value("microphoneDeviceId")}
        deviceLabel={staged.value("microphoneLabel")}
        onChange={(deviceId, deviceLabel) => {
          staged.set("microphoneDeviceId", deviceId);
          staged.set("microphoneLabel", deviceLabel);
        }}
      />
      <DeviceSelect
        label={t("settings.speakerLabelField")}
        kind="audiooutput"
        deviceId={staged.value("speakerDeviceId")}
        deviceLabel={staged.value("speakerLabel")}
        onChange={(deviceId, deviceLabel) => {
          staged.set("speakerDeviceId", deviceId);
          staged.set("speakerLabel", deviceLabel);
        }}
      />
      {devicesChanged ? (
        <div className="settings-warning">{t("settings.devicesWarning")}</div>
      ) : null}
    </div>
  );
}

function VideoSection({ staged }: { staged: StagedSettings }): React.JSX.Element {
  const t = useT();
  return (
    <div>
      <h3>{t("settings.cameraHeader")}</h3>
      <DeviceSelect
        label={t("settings.defaultCamera")}
        kind="videoinput"
        deviceId={staged.value("cameraDeviceId")}
        deviceLabel={staged.value("cameraLabel")}
        onChange={(deviceId, deviceLabel) => {
          staged.set("cameraDeviceId", deviceId);
          staged.set("cameraLabel", deviceLabel);
        }}
      />
      {staged.differs("cameraDeviceId") ? (
        <div className="settings-warning">{t("settings.cameraWarning")}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account — immediate buttons (oak parity)
// ---------------------------------------------------------------------------

function AccountSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const canChangeLogin = useStore(session.permissionStore, (state) =>
    state.my?.permissions.includes(CHANGE_NICKNAME_PERMISSION) ?? false);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  const ownDisplayName = useDisplayName(session, ownUsername);

  return (
    <div>
      <h3>{t("settings.changePasswordHeader")}</h3>
      <div className="settings-hint">
        {t("settings.changePasswordHint", { name: ownDisplayName })}
      </div>
      <PasswordForm />
      {canChangeLogin ? (
        <>
          <h3>{t("settings.changeLoginHeader")}</h3>
          <div className="settings-hint">{t("settings.changeLoginHint")}</div>
          <LoginForm current={ownUsername} />
        </>
      ) : null}
    </div>
  );
}

/** "Download client logs": a plain utility row (not a profile action — no primary
 *  button), PasswordForm's busy/status idiom. Lives in Diagnostics (any member,
 *  no permissions) and is duplicated in Server Settings → Server (the admin
 *  downloads everything from one place). */
function ClientLogsRow(): React.JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus(t("settings.preparing"));
    const outcome = await downloadClientLogs();
    setStatus(outcome === "saved" ? t("settings.savedStatus") : t("settings.exportFailed"));
    setBusy(false);
  };

  return (
    <div className="modal-actions left">
      <button disabled={busy} onClick={() => void download()}>{t("settings.downloadClientLogs")}</button>
      <span className="settings-status">{status ?? ""}</span>
    </div>
  );
}

function PasswordForm(): React.JSX.Element {
  const t = useT();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // oak's validation ladder: length → match → must differ from the current one.
  const validation
    = newPassword.length > 0 && newPassword.length < 8 ? t("settings.pwTooShort")
    : confirmPassword.length > 0 && newPassword !== confirmPassword ? t("settings.pwNoMatch")
    : oldPassword.length > 0 && newPassword.length >= 8 && newPassword === oldPassword
      ? t("settings.pwSame")
    : null;

  const submit = async (): Promise<void> => {
    if (busy || validation !== null || oldPassword.length === 0 || newPassword.length < 8) {
      return;
    }
    setBusy(true);
    setStatus(t("settings.changing"));
    try {
      await changeAccountPassword(oldPassword, newPassword);
      setStatus(t("settings.pwChanged"));
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field"><span>{t("settings.currentPassword")}</span>
        <PasswordInput value={oldPassword} onChange={setOldPassword} autoComplete="current-password" />
      </label>
      <label className="settings-field"><span>{t("settings.newPassword")}</span>
        <PasswordInput value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
      </label>
      <label className="settings-field"><span>{t("settings.confirmNewPassword")}</span>
        <PasswordInput value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
      </label>
      <div className="modal-actions left">
        <button className="primary" disabled={busy || validation !== null || oldPassword.length === 0 || newPassword.length < 8 || newPassword !== confirmPassword}
          onClick={() => void submit()}>
          {t("settings.changePasswordHeader")}
        </button>
        <span className="settings-status">{validation ?? status ?? ""}</span>
      </div>
    </div>
  );
}

function LoginForm({ current }: { current: string }): React.JSX.Element {
  const t = useT();
  const [login, setLogin] = useState(current);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = inVoiceOrCall();
  const validation
    = login.length > 0 && (login.length < 3 || login.length > 32) ? t("settings.loginLength")
    : null;

  const submit = async (): Promise<void> => {
    if (busy || validation !== null || blocked || login === current) {
      return;
    }
    setBusy(true);
    setStatus(t("settings.changing"));
    try {
      await changeAccountUsername(login.trim());
      setStatus(t("settings.loginChanged"));
    } catch (error: unknown) {
      // oak's friendly verdicts for the two expected refusals.
      if (error instanceof ApiError && error.status === 409) {
        setStatus(t("settings.loginTaken"));
      } else if (error instanceof ApiError && error.status === 403) {
        setStatus(t("settings.loginNoPermission"));
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field"><span>{t("settings.loginLabel")}</span>
        <input type="text" value={login} onChange={(event) => setLogin(event.target.value)} />
      </label>
      <div className="modal-actions left">
        <button className="primary" disabled={busy || blocked || validation !== null || login === current}
          onClick={() => void submit()}>
          {t("settings.changeLoginHeader")}
        </button>
        <span className="settings-status">
          {blocked ? t("settings.loginBlocked") : validation ?? status ?? ""}
        </span>
      </div>
    </div>
  );
}

/** The nickname form (General): the DISPLAY name everyone sees — an instant
 *  self-rename through the member endpoint (409 = the nickname is taken). */
function NicknameForm({ session, current }: { session: ConnectionSession; current: string }): React.JSX.Element {
  const t = useT();
  const [nickname, setNickname] = useState(current);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selfId = session.selfUserId(); // null until the roster resolves — the form waits

  const trimmed = nickname.trim();
  const submit = async (): Promise<void> => {
    if (busy || selfId === null || trimmed.length === 0 || trimmed === current) {
      return;
    }
    setBusy(true);
    setStatus(t("settings.saving"));
    try {
      await session.renameMember(selfId, trimmed);
      setStatus(t("settings.nickChanged"));
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setStatus(t("settings.nickTaken"));
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const resetToLogin = async (): Promise<void> => {
    if (busy || selfId === null) {
      return;
    }
    setBusy(true);
    setStatus(t("settings.resetting"));
    try {
      await session.resetMemberNickname(selfId);
      setNickname(session.username());
      setStatus(t("settings.nickReset"));
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setStatus(t("settings.nickTaken"));
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field"><span>{t("settings.nicknameHeader")}</span>
        <input type="text" value={nickname} onChange={(event) => setNickname(event.target.value)} />
      </label>
      <div className="modal-actions left">
        <button className="primary" disabled={busy || selfId === null || trimmed.length === 0 || trimmed === current}
          onClick={() => void submit()}>
          {t("settings.changeNickname")}
        </button>
        <button className="ghost" disabled={busy || selfId === null} onClick={() => void resetToLogin()}>{t("settings.resetToLogin")}</button>
        <span className="settings-status">{status ?? ""}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance / Notifications (staged) / Connections (read-only)
// ---------------------------------------------------------------------------

/** Appearance is CLIENT-related (user decision): input/display/image prefs that
 *  apply to every server — no server context header, no nickname (that lives
 *  in General with the rest of the server-scoped identity). */
function AppearanceSection({ staged }: { staged: StagedSettings }): React.JSX.Element {
  const t = useT();
  return (
    <div>
      <h3>{t("settings.messageInputHeader")}</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={staged.value("ctrlEnterSends")}
          onChange={(event) => staged.set("ctrlEnterSends", event.target.checked)}
        />
        <span>{t("settings.ctrlEnterSends")}</span>
      </label>
      <div className="settings-hint">{t("settings.ctrlEnterHint")}</div>
      <h3>{t("settings.messageDisplayHeader")}</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={staged.value("relativeDates")}
          onChange={(event) => staged.set("relativeDates", event.target.checked)}
        />
        <span>{t("settings.relativeDates")}</span>
      </label>
      <div className="settings-hint">{t("settings.relativeDatesHint")}</div>
      <h3>{t("settings.emojiHeader")}</h3>
      <label className="settings-field"><span>{t("settings.jumboEmojiSize")}</span>
        <span className="jumbo-size-row">
          <input
            type="range"
            min={JUMBO_EMOJI_MIN_PX}
            max={JUMBO_EMOJI_MAX_PX}
            step={2}
            value={staged.value("emojiJumboSize")}
            onChange={(event) => staged.set("emojiJumboSize", Number(event.target.value))}
          />
          <span className="jumbo-size-value">{staged.value("emojiJumboSize")} px</span>
          <button
            className="jumbo-reset"
            disabled={staged.value("emojiJumboSize") === JUMBO_EMOJI_DEFAULT_PX}
            onClick={() => staged.set("emojiJumboSize", JUMBO_EMOJI_DEFAULT_PX)}
          >{t("settings.resetToDefault")}</button>
        </span>
      </label>
      <div className="settings-hint">{t("settings.jumboHint")}</div>
    </div>
  );
}

function NotificationsSection({ session, staged }: {
  session: ConnectionSession | null;
  staged: StagedSettings;
}): React.JSX.Element {
  const t = useT();
  const record = useStore(connectionDirectory, (records) =>
    (session !== null ? records.find((entry) => entry.id === session.recordId) : undefined) ?? null);
  const prefs = staged.notif ?? record?.notifPrefs ?? DEFAULT_NOTIFICATION_PREFS;

  return (
    <div>
      <h3>{t("settings.notifGlobalHeader")}</h3>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("notificationsEnabled")}
          onChange={(event) => staged.set("notificationsEnabled", event.target.checked)} />
        <span>{t("settings.enableNotifications")}</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("soundEnabled")}
          onChange={(event) => staged.set("soundEnabled", event.target.checked)} />
        <span>{t("settings.playSounds")}</span>
      </label>
      <div className="settings-hint">{t("settings.soundsHint")}</div>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("badgeEnabled")}
          onChange={(event) => staged.set("badgeEnabled", event.target.checked)} />
        <span>{t("settings.showUnread")}</span>
      </label>
      <label className="settings-field"><span>{t("settings.toastDismiss")}</span>
        <select value={staged.value("toastDismissSeconds")}
          onChange={(event) => staged.set("toastDismissSeconds", Number(event.target.value))}>
          {[3, 4, 5, 6, 8, 10, 12, 15].map((seconds) => (
            <option key={seconds} value={seconds}>{t("settings.nSeconds", { count: seconds })}</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>{t("settings.maxToasts")}</span>
        <select value={staged.value("maxToasts")}
          onChange={(event) => staged.set("maxToasts", Number(event.target.value))}>
          {Array.from({ length: 10 }, (_unused, index) => index + 1).map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>{t("settings.ringTimeout")}</span>
        <select value={staged.value("ringTimeoutSeconds")}
          onChange={(event) => staged.set("ringTimeoutSeconds", Number(event.target.value))}>
          <option value={0}>{t("settings.ringOff")}</option>
          {[30, 60, 120, 180, 300].map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds < 60
                ? t("settings.nSeconds", { count: seconds })
                : t("settings.nMinutes", { count: seconds / 60 })}
            </option>
          ))}
        </select>
      </label>
      {session !== null ? (
        <>
          <h3>{t("settings.notifServerHeader", { server: record?.cachedServerName ?? session.hostUrl() })}</h3>
          <label className="settings-field"><span>{t("settings.showToastsFor")}</span>
            <select value={prefs.mode}
              onChange={(event) => staged.setNotif({ ...prefs, mode: event.target.value as NotificationPrefs["mode"] })}>
              <option value="ALL">{t("settings.notifModeAll")}</option>
              <option value="MENTIONS">{t("settings.notifModeMentions")}</option>
              <option value="NOTHING">{t("settings.notifModeNothing")}</option>
            </select>
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={prefs.suppressEveryoneHere}
              onChange={(event) => staged.setNotif({ ...prefs, suppressEveryoneHere: event.target.checked })} />
            <span>{t("settings.suppressEveryone")}</span>
          </label>
      <div className="settings-hint">{t("settings.suppressHint")}</div>
        </>
      ) : null}
    </div>
  );
}

/** The client-side diagnostics surface: connection info (the former Connections
 *  section) plus the client-logs download. Renamed from "Connections" (user
 *  decision 2026-10-07): the section is where ANY member — admin or not — grabs
 *  their own log archive for a problem report; "Diagnostics" says what it is
 *  for, "Connections" said only what a third of it shows. Client-scoped, so the
 *  ⚙ button opens it for everyone; no server permission is involved. */
function DiagnosticsSection({ session }: { session: ConnectionSession | null }): React.JSX.Element {
  const t = useT();
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = session !== null
    ? records.find((entry) => entry.id === session.recordId) ?? null
    : null;
  // The CLIENT's own build (user request 2026-10-27): "did the update land?"
  // answered without the log. Plain package.json version in dev, exe version
  // when packaged. Shown with or without a session — the section is client-scoped.
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.spaceUpdates?.getVersion()
      .then((version) => setClientVersion(typeof version === "string" ? version : null))
      .catch(() => undefined);
  }, []);
  // The ADVERTISED address a member types into "Add server" — stored server-side
  // in the profile (oak's activeServerConnectionAddress), NOT our connect URL.
  const address = session !== null
    ? advertisedAddress(
        session.serverProfile?.connectionHost ?? null,
        session.serverProfile?.connectionPort ?? null,
      )
    : null;
  return (
    <div>
      <div className="settings-hint">{t("settings.clientVersion", { version: clientVersion ?? "…" })}</div>
      {session !== null ? (
        <>
          <h3>{t("settings.thisServerHeader")}</h3>
          <div className="settings-hint">{record?.cachedServerName ?? session.hostUrl()}</div>
          {/* The advertised address is what a NEW member types into "Add server". When the
              server has not set one, fall back to the address THIS client is connected by —
              it demonstrably works, unlike the old "not set by the server" dead end. */}
          <div className="settings-hint">
            {t("settings.addressToEnter", { address: address ?? (record?.hostUrl ?? session.hostUrl()) })}
          </div>
          {/* The compatibility skeleton (2026-10-15): the build the client is talking to —
              the first thing to check when a button is mysteriously missing. Old servers
              predate the field; "unknown" is the honest answer there. */}
          <div className="settings-hint">
            {t("settings.serverVersion", { version: session.serverProfile?.version ?? t("settings.unknownVersion") })}
          </div>
        </>
      ) : null}
      <h3>{t("settings.savedConnections")}</h3>
      {records.map((entry) => (
        <div key={entry.id} className="settings-hint">
          {entry.cachedServerName ?? entry.hostUrl} — {entry.hostUrl}
        </div>
      ))}
      <h3>{t("settings.clientLogsHeader")}</h3>
      <div className="settings-hint">{t("settings.clientLogsHint")}</div>
      <ClientLogsRow />
    </div>
  );
}

/** Diagnostics → Downloads (2026-10-19 user request): the ONE folder every
 *  client save lands in — <OS Downloads>/SPACE by default or the chosen
 *  override. Change opens the OS folder picker (an instant quiet write — the
 *  main process reads the setting at save time), Open reveals the folder. */
function DownloadsFolderRow(): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null);
  const [configured, setConfigured] = useState<string | null>(null);
  const t = useT();
  const refresh = async (): Promise<void> => {
    const info = await window.spaceMedia?.downloadsInfo();
    if (info !== null && info !== undefined) {
      setFolder(info.folder);
      setConfigured(info.configured);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const choose = async (): Promise<void> => {
    const picked = await window.spaceMedia?.chooseDownloadsDir();
    if (picked !== null && picked !== undefined) {
      settingsStore.apply({ downloadsFolder: picked });
      await refresh();
    }
  };
  const reset = async (): Promise<void> => {
    settingsStore.apply({ downloadsFolder: null });
    await refresh();
  };
  return (
    <div>
      <div className="settings-hint downloads-folder-path">
        {folder ?? "…"}{configured === null ? t("settings.defaultSuffix") : ""}
      </div>
      <div className="modal-actions left">
        <button onClick={() => void choose()}>{t("settings.changeFolder")}</button>
        {configured !== null ? (
          <button className="ghost" onClick={() => void reset()}>{t("settings.resetToDefault")}</button>
        ) : null}
        <button className="ghost" onClick={() => void window.spaceMedia?.openDownloadsDir()}>{t("settings.openFolder")}</button>
      </div>
    </div>
  );
}

/** General (CLIENT scope) — the ⚙ window's front tab (user request
 *  2026-10-19): the downloads folder and the disk-cache size moved here from
 *  Diagnostics and Appearance; the Updates block joined them (2026-10-20).
 *  Immediate writes, no Apply step — the same persistedGain category as
 *  Diagnostics. */
function GeneralClientSection({ session }: { session: ConnectionSession | null }): React.JSX.Element {
  const t = useT();
  const language = useStore(settingsStore, (settings) => settings.language);
  const cacheMegabytes = useStore(settingsStore, (state) => state.imageCacheMegabytes);
  const changeCache = (megabytes: number): void => {
    settingsStore.apply({ imageCacheMegabytes: megabytes });
    if (session !== null) {
      session.attachmentCache.setDiskBudget(megabytes * 1024 * 1024); // 0 purges the disk layer
    }
  };
  return (
    <div>
      <h3>{t("settings.language.label")}</h3>
      <select value={language} onChange={(event) => settingsStore.apply({ language: event.target.value as LanguageSetting })}>
        {/* The options self-name their language (the industry convention);
            only "System default" translates. */}
        <option value="system">{t("settings.language.system")}</option>
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </select>
      <h3>{t("settings.updatesHeader")}</h3>
      <UpdatesSettingsBlock />
      <h3>{t("settings.downloadsHeader")}</h3>
      <div className="settings-hint">{t("settings.downloadsHint")}</div>
      <DownloadsFolderRow />
      <h3>{t("settings.cacheHeader")}</h3>
      <label className="settings-field"><span>{t("settings.diskCacheSize")}</span>
        <select value={cacheMegabytes} onChange={(event) => changeCache(Number(event.target.value))}>
          {DISK_CACHE_CHOICES.map((size) => (
            <option key={size} value={size}>{diskCacheLabel(size)}</option>
          ))}
        </select>
      </label>
      <div className="settings-hint">{t("settings.cacheHint")}</div>
    </div>
  );
}

/** The Updates block of the client General section (user decisions 2026-10-20):
 *  the always-on "Update available" row (it ignores both Skip and the banner's
 *  Cancel — the escape hatch after either), the two check toggles (BOTH off =
 *  the mechanism is fully disabled), and a manual Check now that bypasses the
 *  toggles and the idle gate. Immediate writes. */
function UpdatesSettingsBlock(): React.JSX.Element {
  const t = useT();
  const update = useStore(appStore, (state) => state.update);
  const checkOnStartup = useStore(settingsStore, (settings) => settings.updateCheckOnStartup);
  const checkDaily = useStore(settingsStore, (settings) => settings.updateCheckDaily);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const startUpdate = (): void => {
    if (updateInterruptsMedia()) {
      setConfirmOpen(true);
      return;
    }
    proceedUpdateDownload();
  };

  const checkNow = async (): Promise<void> => {
    setCheckNote(t("settings.checkingNote"));
    const result = await manualUpdateCheck();
    if (result.status === "available" && result.version !== null) {
      setCheckNote(t("settings.updateAvailableNote", { version: result.version }));
    } else if (result.status === "none") {
      setCheckNote(t("settings.upToDateNote"));
    } else if (result.status === "unsupported") {
      setCheckNote(t("settings.unsupportedNote"));
    } else {
      setCheckNote(t("settings.checkFailedNote", { message: result.message ?? "unknown error" }));
    }
  };

  return (
    <div>
      {update.version !== null ? (
        <div className="update-settings-row">
          <span>{t("settings.updateAvailablePrefix")} <b>{`v${update.version}`}</b></span>
          {update.status === "downloading" ? (
            <span className="settings-hint">{t("sidebar.update.downloading", { percent: Math.round(update.percent ?? 0) })}</span>
          ) : update.status === "failed" ? (
            <span className="settings-hint">{t("sidebar.update.failed")}</span>
          ) : (
            <button className="primary" onClick={startUpdate}>{t("sidebar.update.updateNow")}</button>
          )}
        </div>
      ) : null}
      <label className="settings-check">
        <input type="checkbox" checked={checkOnStartup}
          onChange={(event) => settingsStore.apply({ updateCheckOnStartup: event.target.checked })} />
        <span>{t("settings.checkOnStartup")}</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={checkDaily}
          onChange={(event) => settingsStore.apply({ updateCheckDaily: event.target.checked })} />
        <span>{t("settings.dailyCheck")}</span>
      </label>
      <div className="settings-hint">{t("settings.updatesHint")}</div>
      <div className="modal-actions left">
        <button onClick={() => void checkNow()}>{t("settings.checkNow")}</button>
        {checkNote !== null ? <span className="settings-hint">{checkNote}</span> : null}
      </div>
      {confirmOpen ? (
        <Modal title={t("sidebar.update.confirmTitle")} onClose={() => setConfirmOpen(false)}>
          <div className="modal-note">{t("sidebar.update.confirmNote")}</div>
          <div className="modal-actions left">
            <button className="ghost" onClick={() => setConfirmOpen(false)}>{t("sidebar.update.notNow")}</button>
            <button className="primary" onClick={() => { setConfirmOpen(false); proceedUpdateDownload(); }}>{t("sidebar.update.updateNow")}</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
