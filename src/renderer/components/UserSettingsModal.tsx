import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  changeAccountPassword,
  changeAccountUsername,
  connectionDirectory,
  inVoiceOrCall,
  roomAudio,
  settingsStore,
  toggleUserSettings,
  updateNotificationPrefs,
} from "../runtime";
import { ApiError } from "../../core/rest";
import type { ClientSettings } from "../../domain/stores/SettingsStore";
import { advertisedAddress, DISK_CACHE_CHOICES, diskCacheLabel } from "../../domain/logic/settings-format";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { CHANGE_NICKNAME_PERMISSION, type NotificationPrefs } from "../../types";
import { Avatar } from "./Avatar";
import { AvatarEditor, userAvatarApi } from "./ProfileModal";

/**
 * User settings — oak's SettingsWindow: General (avatar), Account (password +
 * username mutations with token rotation), Audio (processing + microphone/
 * speaker devices), Video (the default camera), Appearance (input, display,
 * images), Notifications (global + per-server overrides), Connections
 * (read-only). oak's STAGED model for Audio/Video/Appearance/Notifications:
 * the controls write a draft in memory, the window-level Apply button commits,
 * leaving the section (or closing the window) without Apply discards. General/
 * Account/Connections are immediate (oak parity — their buttons act directly).
 */

type Section = "general" | "account" | "audio" | "video" | "appearance" | "notifications" | "connections";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "general", label: "General" },
  { key: "account", label: "Account" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
  { key: "appearance", label: "Appearance" },
  { key: "notifications", label: "Notifications" },
  { key: "connections", label: "Connections" },
];

/** The sections that stage their edits behind the window-level Apply button. */
const STAGED_SECTIONS: ReadonlySet<Section> = new Set(["audio", "video", "appearance", "notifications"]);

/** A referentially STABLE never-configured default (a literal in a selector
 *  re-creates itself on every emit and rips useSyncExternalStore into a
 *  re-render loop — the M6 lesson). */
const DEFAULT_NOTIF_PREFS: NotificationPrefs = { mode: "ALL", suppressEveryoneHere: false };

/** oak's pane heading — the same chrome Server Settings sections carry. */
function SectionHeading({ title }: { title: string }): React.JSX.Element {
  return <div className="roles-list-header overview-heading"><span>{title}</span></div>;
}

export function UserSettingsModal({ session }: { session: ConnectionSession }): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const staged = useStagedSettings(session);

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
        <div className="settings-nav-title">User Settings</div>
        {SECTIONS.map((entry) => (
          <button
            key={entry.key}
            className={"settings-nav-item" + (entry.key === section ? " active" : "")}
            onClick={() => selectSection(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        <SectionHeading title={SECTIONS.find((entry) => entry.key === section)?.label ?? ""} />
        {section === "general" ? <GeneralSection session={session} /> : null}
        {section === "account" ? <AccountSection session={session} /> : null}
        {section === "audio" ? <AudioSection staged={staged} /> : null}
        {section === "video" ? <VideoSection staged={staged} /> : null}
        {section === "appearance" ? <AppearanceSection staged={staged} /> : null}
        {section === "notifications" ? <NotificationsSection session={session} staged={staged} /> : null}
        {section === "connections" ? <ConnectionsSection session={session} /> : null}
        {/* The Apply button hugs the section content (staged sections only) and
            commits the draft; leaving the section without it discards. */}
        {STAGED_SECTIONS.has(section) ? (
          <div className="modal-actions left settings-apply">
            <button className="primary" disabled={!staged.changed} onClick={staged.commit}>Apply</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The staged draft (oak's syncControls/applyButton wiring, React shape)
// ---------------------------------------------------------------------------

interface StagedSettings {
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

function useStagedSettings(session: ConnectionSession): StagedSettings {
  const [draft, setDraft] = useState<Partial<ClientSettings>>({});
  const [notifDraft, setNotifDraft] = useState<NotificationPrefs | null>(null);
  const stored = useStore(settingsStore, (snapshot) => snapshot);
  const storedNotif = useStore(connectionDirectory, (records) =>
    records.find((entry) => entry.id === session.recordId)?.notifPrefs ?? DEFAULT_NOTIF_PREFS);

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
      }
      if (applied.imageCacheMegabytes !== undefined) {
        session.attachmentCache.setDiskBudget(applied.imageCacheMegabytes * 1024 * 1024); // 0 purges the disk layer
      }
    }
    const stagedNotif = notifDraft;
    setNotifDraft(null);
    if (stagedNotif !== null) {
      void updateNotificationPrefs(session.recordId, stagedNotif);
    }
  };

  const discard = (): void => {
    setDraft({});
    setNotifDraft(null);
  };

  return { value, set, differs, changed, notif: notifDraft, setNotif: setNotifDraft, commit, discard };
}

// ---------------------------------------------------------------------------
// General — the avatar, in the Server Settings → Overview idiom
// ---------------------------------------------------------------------------

function GeneralSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  return (
    <div>
      {/* Overview idiom: the identity name rides under the heading in the
          role-editor typography — no pencil, renaming lives in Account. */}
      <div className="role-editor-title-row">
        <span className="role-editor-name">{ownUsername}</span>
      </div>
      <AvatarEditor
        session={session}
        api={userAvatarApi(session)}
        preview={<Avatar session={session} username={ownUsername} size={96} />}
        stacked
        removeTitle="Remove avatar"
        removeNote="Remove your avatar? This cannot be undone."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices (oak Audio/Video pickers over enumerateDevices)
// ---------------------------------------------------------------------------

/** One "System default + every device" row; labels may be blank before the
 *  first capture grant (Chromium hides them without permission). */
function DeviceSelect({ label, kind, value, onChange }: {
  label: string;
  kind: MediaDeviceKind;
  value: string | null;
  onChange(deviceId: string | null): void;
}): React.JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      setDevices(all.filter((device) => device.kind === kind));
    }).catch(() => undefined);
  }, [kind]);
  const rowLabel = (device: MediaDeviceInfo): string =>
    device.label.length > 0 ? device.label : `${kind} ${device.deviceId.slice(-6)}`;
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">System default</option>
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
  const devicesChanged = staged.differs("microphoneDeviceId")
    || staged.differs("speakerDeviceId");
  return (
    <div>
      <h3>Devices</h3>
      <DeviceSelect
        label="Microphone"
        kind="audioinput"
        value={staged.value("microphoneDeviceId")}
        onChange={(deviceId) => staged.set("microphoneDeviceId", deviceId)}
      />
      <DeviceSelect
        label="Speaker / headphones"
        kind="audiooutput"
        value={staged.value("speakerDeviceId")}
        onChange={(deviceId) => staged.set("speakerDeviceId", deviceId)}
      />
      {devicesChanged ? (
        <div className="settings-warning">
          The microphone takes effect on the next call; the speaker switches immediately.
        </div>
      ) : null}
    </div>
  );
}

function VideoSection({ staged }: { staged: StagedSettings }): React.JSX.Element {
  return (
    <div>
      <h3>Camera</h3>
      <DeviceSelect
        label="Default camera"
        kind="videoinput"
        value={staged.value("cameraDeviceId")}
        onChange={(deviceId) => staged.set("cameraDeviceId", deviceId)}
      />
      {staged.differs("cameraDeviceId") ? (
        <div className="settings-warning">Changes take effect on the next call.</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account — immediate buttons (oak parity)
// ---------------------------------------------------------------------------

function AccountSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const canRename = useStore(session.permissionStore, (state) =>
    state.my?.permissions.includes(CHANGE_NICKNAME_PERMISSION) ?? false);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  const record = connectionDirectory.get(session.recordId);

  return (
    <div>
      <h3>Change password</h3>
      <div className="settings-hint">
        Changes the password for {ownUsername} on {record?.cachedServerName ?? session.hostUrl()}.
        The session stays connected.
      </div>
      <PasswordForm />
      {canRename ? (
        <>
          <h3>Change username</h3>
          <div className="settings-hint">Not available while in voice or a call.</div>
          <UsernameForm current={ownUsername} />
        </>
      ) : null}
    </div>
  );
}

function PasswordForm(): React.JSX.Element {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // oak's validation ladder: length → match → must differ from the current one.
  const validation
    = newPassword.length > 0 && newPassword.length < 8 ? "New password must be at least 8 characters."
    : confirmPassword.length > 0 && newPassword !== confirmPassword ? "New passwords do not match."
    : oldPassword.length > 0 && newPassword.length >= 8 && newPassword === oldPassword
      ? "New password must be different from the current one."
    : null;

  const submit = async (): Promise<void> => {
    if (busy || validation !== null || oldPassword.length === 0 || newPassword.length < 8) {
      return;
    }
    setBusy(true);
    setStatus("Changing…");
    try {
      await changeAccountPassword(oldPassword, newPassword);
      setStatus("Password changed.");
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
      <label className="settings-field"><span>Current password</span>
        <input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
      </label>
      <label className="settings-field"><span>New password (at least 8 characters)</span>
        <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </label>
      <label className="settings-field"><span>Confirm new password</span>
        <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      </label>
      <div className="modal-actions left">
        <button className="primary" disabled={busy || validation !== null || oldPassword.length === 0 || newPassword.length < 8 || newPassword !== confirmPassword}
          onClick={() => void submit()}>
          Change password
        </button>
        <span className="settings-status">{validation ?? status ?? ""}</span>
      </div>
    </div>
  );
}

function UsernameForm({ current }: { current: string }): React.JSX.Element {
  const [username, setUsername] = useState(current);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = inVoiceOrCall();
  const validation
    = username.length > 0 && (username.length < 3 || username.length > 32) ? "Username must be 3–32 characters."
    : null;

  const submit = async (): Promise<void> => {
    if (busy || validation !== null || blocked || username === current) {
      return;
    }
    setBusy(true);
    setStatus("Changing…");
    try {
      await changeAccountUsername(username.trim());
      setStatus("Username changed.");
    } catch (error: unknown) {
      // oak's friendly verdicts for the two expected refusals.
      if (error instanceof ApiError && error.status === 409) {
        setStatus("Username already taken.");
      } else if (error instanceof ApiError && error.status === 403) {
        setStatus("You do not have permission to change your nickname.");
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field"><span>Username</span>
        <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <div className="modal-actions left">
        <button className="primary" disabled={busy || blocked || validation !== null || username === current}
          onClick={() => void submit()}>
          Change username
        </button>
        <span className="settings-status">
          {blocked ? "Leave voice and calls before changing your username." : validation ?? status ?? ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance / Notifications (staged) / Connections (read-only)
// ---------------------------------------------------------------------------

function AppearanceSection({ staged }: { staged: StagedSettings }): React.JSX.Element {
  return (
    <div>
      <h3>Message input</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={staged.value("ctrlEnterSends")}
          onChange={(event) => staged.set("ctrlEnterSends", event.target.checked)}
        />
        <span>Ctrl+Enter sends the message</span>
      </label>
      <div className="settings-hint">
        Default: Enter sends, Ctrl+Enter or Shift+Enter insert a newline.
        With this on, the roles swap — Shift+Enter always stays a newline.
        Applies to the composer and the inline editor instantly.
      </div>
      <h3>Message display</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={staged.value("relativeDates")}
          onChange={(event) => staged.set("relativeDates", event.target.checked)}
        />
        <span>Relative dates (Today / Yesterday)</span>
      </label>
      <div className="settings-hint">
        When off, message timestamps always show the date (for example,
        Aug 20 at 14:05) instead of Today / Yesterday.
      </div>
      <h3>Images</h3>
      <label className="settings-field"><span>Disk cache size</span>
        <select
          value={staged.value("imageCacheMegabytes")}
          onChange={(event) => staged.set("imageCacheMegabytes", Number(event.target.value))}
        >
          {DISK_CACHE_CHOICES.map((size) => (
            <option key={size} value={size}>{diskCacheLabel(size)}</option>
          ))}
        </select>
      </label>
      <div className="settings-hint">
        The disk cache stores avatars and attachments by their stable key; Off keeps
        everything in memory only (nothing is written to disk).
      </div>
    </div>
  );
}

function NotificationsSection({ session, staged }: {
  session: ConnectionSession;
  staged: StagedSettings;
}): React.JSX.Element {
  const record = useStore(connectionDirectory, (records) =>
    records.find((entry) => entry.id === session.recordId) ?? null);
  const prefs = staged.notif ?? record?.notifPrefs ?? DEFAULT_NOTIF_PREFS;

  return (
    <div>
      <h3>Global</h3>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("notificationsEnabled")}
          onChange={(event) => staged.set("notificationsEnabled", event.target.checked)} />
        <span>Enable notifications</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("soundEnabled")}
          onChange={(event) => staged.set("soundEnabled", event.target.checked)} />
        <span>Play mention sound</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={staged.value("badgeEnabled")}
          onChange={(event) => staged.set("badgeEnabled", event.target.checked)} />
        <span>Show unread counters</span>
      </label>
      <label className="settings-field"><span>Toast dismiss time</span>
        <select value={staged.value("toastDismissSeconds")}
          onChange={(event) => staged.set("toastDismissSeconds", Number(event.target.value))}>
          {[3, 4, 5, 6, 8, 10, 12, 15].map((seconds) => (
            <option key={seconds} value={seconds}>{seconds} seconds</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>Maximum toasts</span>
        <select value={staged.value("maxToasts")}
          onChange={(event) => staged.set("maxToasts", Number(event.target.value))}>
          {Array.from({ length: 10 }, (_unused, index) => index + 1).map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>Ring timeout for outgoing calls</span>
        <select value={staged.value("ringTimeoutSeconds")}
          onChange={(event) => staged.set("ringTimeoutSeconds", Number(event.target.value))}>
          <option value={0}>Off (ring until answered)</option>
          {[30, 60, 120, 180, 300].map((seconds) => (
            <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds >= 120 ? "s" : ""}`}</option>
          ))}
        </select>
      </label>
      <h3>Server — {record?.cachedServerName ?? session.hostUrl()}</h3>
      <label className="settings-field"><span>Show toasts for</span>
        <select value={prefs.mode}
          onChange={(event) => staged.setNotif({ ...prefs, mode: event.target.value as NotificationPrefs["mode"] })}>
          <option value="ALL">All messages</option>
          <option value="MENTIONS">Mentions only</option>
          <option value="NOTHING">Nothing</option>
        </select>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={prefs.suppressEveryoneHere}
          onChange={(event) => staged.setNotif({ ...prefs, suppressEveryoneHere: event.target.checked })} />
        <span>Suppress @everyone and @here</span>
      </label>
      <div className="settings-hint">
        Suppress keeps @everyone/@here out of the red badge (still counted unread).
      </div>
    </div>
  );
}

function ConnectionsSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = records.find((entry) => entry.id === session.recordId) ?? null;
  // The ADVERTISED address a member types into "Add server" — stored server-side
  // in the profile (oak's activeServerConnectionAddress), NOT our connect URL.
  const address = advertisedAddress(
    session.serverProfile?.connectionHost ?? null,
    session.serverProfile?.connectionPort ?? null,
  );
  return (
    <div>
      <h3>This server</h3>
      <div className="settings-hint">{record?.cachedServerName ?? session.hostUrl()}</div>
      <div className="settings-hint">
        Address to enter when connecting: {address ?? "not set by the server"}
      </div>
      <h3>Saved connections</h3>
      {records.map((entry) => (
        <div key={entry.id} className="settings-hint">
          {entry.cachedServerName ?? entry.hostUrl} — {entry.hostUrl}
        </div>
      ))}
      <div className="settings-hint">
        The address is stored on the server; the future set-up flow will fill it in automatically.
      </div>
    </div>
  );
}
