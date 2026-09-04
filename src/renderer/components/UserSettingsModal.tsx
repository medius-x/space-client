import { useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  changeAccountPassword,
  changeAccountUsername,
  connectionDirectory,
  inVoiceOrCall,
  settingsStore,
  toggleUserSettings,
  updateNotificationPrefs,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { CHANGE_NICKNAME_PERMISSION } from "../../types";
import { Modal } from "./Modal";
import { AvatarEditor } from "./ProfileModal";

/**
 * User settings (M7): six sections — General (avatar), Account (password/username
 * mutations with token rotation), Appearance, Notifications (global + per-server
 * overrides), Voice (APM), Connections (read-only). Instant-apply everywhere:
 * every control writes through to the settings store / the record immediately.
 */

type Section = "general" | "account" | "appearance" | "notifications" | "voice" | "connections";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "general", label: "General" },
  { key: "account", label: "Account" },
  { key: "appearance", label: "Appearance" },
  { key: "notifications", label: "Notifications" },
  { key: "voice", label: "Voice" },
  { key: "connections", label: "Connections" },
];

export function UserSettingsModal({ session }: { session: ConnectionSession }): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  return (
    <Modal title="User Settings" onClose={toggleUserSettings} wide>
      <div className="user-settings">
        <div className="settings-nav">
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
        <div className="user-settings-body">
          {section === "general" ? <AvatarEditor session={session} /> : null}
          {section === "account" ? <AccountSection session={session} /> : null}
          {section === "appearance" ? <AppearanceSection session={session} /> : null}
          {section === "notifications" ? <NotificationsSection session={session} /> : null}
          {section === "voice" ? <VoiceSection /> : null}
          {section === "connections" ? <ConnectionsSection session={session} /> : null}
        </div>
      </div>
    </Modal>
  );
}

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

function VoiceSection(): React.JSX.Element {
  const settings = useStore(settingsStore, (snapshot) => snapshot);
  return (
    <div>
      <h3>Voice processing</h3>
      <label className="settings-check">
        <input type="checkbox" checked={settings.apmEnabled}
          onChange={(event) => settingsStore.apply({ apmEnabled: event.target.checked })} />
        <span>Audio processing (echo cancellation, noise suppression, AGC)</span>
      </label>
      <div className="settings-hint">
        Chromium's built-in processing on the microphone. Applies the next time you
        join a voice channel or start a call. A physical mic-in-front-of-speaker loop
        is beyond any canceller — use headphones.
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
