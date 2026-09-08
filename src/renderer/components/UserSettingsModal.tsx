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
import type { ConnectionSession } from "../../domain/session/connection-session";
import { CHANGE_NICKNAME_PERMISSION } from "../../types";
import { UserAvatarEditor } from "./ProfileModal";

/**
 * User settings — oak's SettingsWindow section list: General (avatar), Account
 * (password/username mutations with token rotation), Audio (processing +
 * microphone/speaker devices), Video (the default camera), Appearance (input,
 * display, images), Notifications (global + per-server overrides),
 * Connections (read-only). Instant-apply everywhere: every control writes
 * through immediately; mic/camera take effect on the next capture, the
 * speaker switches live (setSinkId).
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

export function UserSettingsModal({ session }: { session: ConnectionSession }): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        toggleUserSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="settings-screen">
      <div className="settings-nav">
        <div className="settings-nav-title">User Settings</div>
        {SECTIONS.map((entry) => (
          <button
            key={entry.key}
            className={"settings-nav-item" + (entry.key === section ? " active" : "")}
            onClick={() => setSection(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {section === "general" ? <UserAvatarEditor session={session} /> : null}
        {section === "account" ? <AccountSection session={session} /> : null}
        {section === "audio" ? <AudioSection /> : null}
        {section === "video" ? <VideoSection /> : null}
        {section === "appearance" ? <AppearanceSection session={session} /> : null}
        {section === "notifications" ? <NotificationsSection session={session} /> : null}
        {section === "connections" ? <ConnectionsSection session={session} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices (oak Audio/Video pickers over enumerateDevices)
// ---------------------------------------------------------------------------

/** One "System default + every device" row; labels may be blank before the
 *  first capture grant (Chromium hides them without permission). */
function DeviceSelect({ label, kind, value, live, onChange }: {
  label: string;
  kind: MediaDeviceKind;
  value: string | null;
  live: boolean;
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
      <span>{label}{live ? " (applies immediately)" : ""}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">System default</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>{rowLabel(device)}</option>
        ))}
      </select>
    </label>
  );
}

function AudioSection(): React.JSX.Element {
  const settings = useStore(settingsStore, (snapshot) => snapshot);
  return (
    <div>
      <h3>Processing</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.apmEnabled}
          onChange={(event) => settingsStore.apply({ apmEnabled: event.target.checked })}
        />
        <span>Built-in audio processing (echo cancellation, noise suppression, AGC)</span>
      </label>
      <div className="settings-hint">
        Chromium's processing on the microphone — this client's noise-suppression
        engine (the Raw option in the voice-bar selector turns it off). Applies
        the next time you join voice or start a call.
      </div>
      <h3>Devices</h3>
      <DeviceSelect
        label="Microphone"
        kind="audioinput"
        value={settings.microphoneDeviceId}
        live={false}
        onChange={(deviceId) => settingsStore.apply({ microphoneDeviceId: deviceId })}
      />
      <DeviceSelect
        label="Speaker / headphones"
        kind="audiooutput"
        value={settings.speakerDeviceId}
        live
        onChange={(deviceId) => {
          settingsStore.apply({ speakerDeviceId: deviceId });
          roomAudio.setOutputDevice(deviceId);
        }}
      />
      <div className="settings-hint">
        Microphone and camera take effect on the next call; the speaker switches
        immediately.
      </div>
    </div>
  );
}

function VideoSection(): React.JSX.Element {
  const settings = useStore(settingsStore, (snapshot) => snapshot);
  return (
    <div>
      <h3>Camera</h3>
      <DeviceSelect
        label="Default camera"
        kind="videoinput"
        value={settings.cameraDeviceId}
        live={false}
        onChange={(deviceId) => settingsStore.apply({ cameraDeviceId: deviceId })}
      />
      <div className="settings-hint">
        The camera the voice-bar share picker's Camera tab and the call toggle
        open; screen and window shares always pick their source explicitly.
        Changes take effect on the next call.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account
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
        The session stays connected — the token pair rotates silently.
      </div>
      <PasswordForm />
      {canRename ? (
        <>
          <h3>Change username</h3>
          <div className="settings-hint">
            Rotates every token family and restarts the connection (the login name is
            the token subject). Not available while in voice or a call.
          </div>
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

  const validation
    = newPassword.length > 0 && newPassword.length < 8 ? "New password must be at least 8 characters."
    : confirmPassword.length > 0 && newPassword !== confirmPassword ? "New passwords do not match."
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
      <div className="modal-actions">
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
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field"><span>Username</span>
        <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <div className="modal-actions">
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
// Appearance / Notifications / Connections
// ---------------------------------------------------------------------------

function AppearanceSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const settings = useStore(settingsStore, (snapshot) => snapshot);
  return (
    <div>
      <h3>Message input</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.ctrlEnterSends}
          onChange={(event) => settingsStore.apply({ ctrlEnterSends: event.target.checked })}
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
          checked={settings.relativeDates}
          onChange={(event) => settingsStore.apply({ relativeDates: event.target.checked })}
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
          value={settings.imageCacheMegabytes}
          onChange={(event) => {
            const megabytes = Number(event.target.value);
            settingsStore.apply({ imageCacheMegabytes: megabytes });
            session.attachmentCache.setDiskBudget(megabytes * 1024 * 1024); // 0 purges the disk layer
          }}
        >
          {[0, 64, 128, 256, 512, 1024, 2048].map((size) => (
            <option key={size} value={size}>{size === 0 ? "Off (memory only)" : `${size} MB`}</option>
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

function NotificationsSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const settings = useStore(settingsStore, (snapshot) => snapshot);
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = records.find((entry) => entry.id === session.recordId) ?? null;
  const prefs = record?.notifPrefs ?? { mode: "ALL" as const, suppressEveryoneHere: false };

  return (
    <div>
      <h3>Global</h3>
      <label className="settings-check">
        <input type="checkbox" checked={settings.notificationsEnabled}
          onChange={(event) => settingsStore.apply({ notificationsEnabled: event.target.checked })} />
        <span>Enable notifications</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={settings.soundEnabled}
          onChange={(event) => settingsStore.apply({ soundEnabled: event.target.checked })} />
        <span>Play mention sound</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={settings.badgeEnabled}
          onChange={(event) => settingsStore.apply({ badgeEnabled: event.target.checked })} />
        <span>Show unread counters</span>
      </label>
      <label className="settings-field"><span>Toast dismiss time</span>
        <select value={settings.toastDismissSeconds}
          onChange={(event) => settingsStore.apply({ toastDismissSeconds: Number(event.target.value) })}>
          {[3, 4, 5, 6, 8, 10, 12, 15].map((seconds) => (
            <option key={seconds} value={seconds}>{seconds} seconds</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>Maximum toasts</span>
        <select value={settings.maxToasts}
          onChange={(event) => settingsStore.apply({ maxToasts: Number(event.target.value) })}>
          {Array.from({ length: 10 }, (_unused, index) => index + 1).map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
        </select>
      </label>
      <label className="settings-field"><span>Ring timeout for outgoing calls</span>
        <select value={settings.ringTimeoutSeconds}
          onChange={(event) => settingsStore.apply({ ringTimeoutSeconds: Number(event.target.value) })}>
          <option value={0}>Off (ring until answered)</option>
          {[30, 60, 120, 180, 300].map((seconds) => (
            <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds >= 120 ? "s" : ""}`}</option>
          ))}
        </select>
      </label>
      <h3>Server — {record?.cachedServerName ?? session.hostUrl()}</h3>
      <label className="settings-field"><span>Show toasts for</span>
        <select value={prefs.mode}
          onChange={(event) => void updateNotificationPrefs(session.recordId, { mode: event.target.value as "ALL" | "MENTIONS" | "NOTHING" })}>
          <option value="ALL">All messages</option>
          <option value="MENTIONS">Mentions only</option>
          <option value="NOTHING">Nothing</option>
        </select>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={prefs.suppressEveryoneHere}
          onChange={(event) => void updateNotificationPrefs(session.recordId, { suppressEveryoneHere: event.target.checked })} />
        <span>Suppress @everyone and @here</span>
      </label>
      <div className="settings-hint">
        MENTIONS/NOTHING only gate toasts and sounds — the unread badges keep counting.
        Suppress keeps @everyone/@here out of the red badge (still counted unread).
      </div>
    </div>
  );
}

function ConnectionsSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = records.find((entry) => entry.id === session.recordId) ?? null;
  return (
    <div>
      <h3>This server</h3>
      <div className="settings-hint">{record?.cachedServerName ?? session.hostUrl()}</div>
      <div className="settings-hint">Address to enter when connecting: {session.hostUrl()}</div>
      <h3>Saved connections</h3>
      {records.map((entry) => (
        <div key={entry.id} className="friend-row">
          <span>{entry.username}</span>
          <span className="settings-hint">{entry.hostUrl}</span>
        </div>
      ))}
    </div>
  );
}
