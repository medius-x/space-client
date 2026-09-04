import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, joinVoice, setActiveChannel } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Channel } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { ProfileModal } from "./ProfileModal";
import { VoiceMarks } from "./VoiceRoom";

/**
 * Channel list + online roster, fed by the session's stores. Channel CRUD lives in
 * the context menu (right-click a channel) and the section "+" buttons.
 */
export function Sidebar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const roster = useStore(session.rosterStore, (roster) => roster);
  const readStates = useStore(session.readStateStore, (states) => states);
  const voiceMarks = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const canManageChannels = useStore(session.permissionStore, (state) => state.my?.permissions.includes("MANAGE_CHANNELS") ?? false);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);

  const [menu, setMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null);
  const [createType, setCreateType] = useState<"TEXT" | "VOICE" | null>(null);
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const textChannels = channels.filter((channel) => channel.type === "TEXT");
  const voiceChannels = channels.filter((channel) => channel.type === "VOICE");
  const onlineCount = roster.users.filter((user) => roster.presence.has(user.username)).length;

  const onTextChannelClick = (channel: Channel) => {
    if (!channel.locked) {
      setActiveChannel(channel.id);
    }
  };
  const onVoiceChannelClick = (channel: Channel) => {
    if (channel.id !== activeVoiceChannelId) {
      void joinVoice(channel);
    }
  };
  const openMenu = (channel: Channel) => (event: React.MouseEvent) => {
    event.preventDefault();
    // oak parity: without MANAGE_CHANNELS the right-click does nothing at all.
    if (canManageChannels) {
      setMenu({ channel, x: event.clientX, y: event.clientY });
    }
  };
  const menuItems: ContextMenuItem[] = menu === null ? [] : [
    { label: "Rename channel", action: () => setRenameTarget(menu.channel) },
    { label: "Delete channel", danger: true, action: () => setDeleteTarget(menu.channel) },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-section-title">
        <span>Text channels</span>
        {canManageChannels ? (
          <button className="section-add" title="Create text channel" onClick={() => setCreateType("TEXT")}>+</button>
        ) : null}
      </div>
      {textChannels.map((channel) => {
        const unread = readStates.get(channel.id);
        return (
          <div
            key={channel.id}
            className={"channel-row"
              + (channel.id === activeChannelId ? " active" : "")
              + (channel.locked ? " locked" : "")}
            title={channel.locked ? "Locked for you" : undefined}
            onClick={() => onTextChannelClick(channel)}
            onContextMenu={openMenu(channel)}
          >
            <span className="channel-name"><span className="channel-hash">#</span> {channel.name}</span>
            {unread !== undefined && unread.unreadCount > 0 ? (
              <span className={"channel-badge" + (unread.mentionCount > 0 ? " mention" : "")}>
                {unread.unreadCount > 99 ? "99+" : unread.unreadCount}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="sidebar-section-title">
        <span>Voice channels</span>
        {canManageChannels ? (
          <button className="section-add" title="Create voice channel" onClick={() => setCreateType("VOICE")}>+</button>
        ) : null}
      </div>
      {voiceChannels.map((channel) => (
        <div key={channel.id}>
          <div
            className={"channel-row"
              + (channel.id === activeVoiceChannelId ? " active" : "")
              + (channel.locked ? " locked" : "")}
            onClick={() => onVoiceChannelClick(channel)}
            onContextMenu={openMenu(channel)}
          >
            🔊 {channel.name}
          </div>
          {[...(roster.voiceMembers.get(channel.id) ?? [])].map((username) => (
            <div key={username} className="member-row">
              <span className="presence-dot online" />
              <span className="member-name">{username}{username === ownUsername ? " (you)" : ""}</span>
              <VoiceMarks marks={voiceMarks.get(username)} />
            </div>
          ))}
        </div>
      ))}
      <div className="sidebar-section-title">Online — {onlineCount}</div>
      {roster.users.map((user) => (
        <div key={user.id} className="member-row">
          <span className={"presence-dot" + (roster.presence.has(user.username) ? " online" : "")} />
          <Avatar session={session} username={user.username} size={20} />
          <span className="member-name">{user.username}</span>
        </div>
      ))}
      <div className="user-bar">
        <Avatar session={session} username={ownUsername ?? session.username()} size={32} />
        <span className="member-name">{ownUsername ?? session.username()}</span>
        <button className="ghost user-bar-button" title="Profile" onClick={() => setProfileOpen(true)}>👤</button>
      </div>
      {profileOpen ? <ProfileModal session={session} onClose={() => setProfileOpen(false)} /> : null}

      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
      {createType !== null ? <CreateChannelModal session={session} type={createType} onClose={() => setCreateType(null)} /> : null}
      {renameTarget !== null ? <RenameChannelModal session={session} channel={renameTarget} onClose={() => setRenameTarget(null)} /> : null}
      {deleteTarget !== null ? <DeleteChannelModal session={session} channel={deleteTarget} onClose={() => setDeleteTarget(null)} /> : null}
    </aside>
  );
}

function CreateChannelModal({ session, type, onClose }: {
  session: ConnectionSession;
  type: "TEXT" | "VOICE";
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"TEXT" | "VOICE">(type);
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
      await session.createChannel({ name: trimmed, type: kind });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create channel" onClose={onClose}>
      <div className="modal-row">
        <label className={"kind-choice" + (kind === "TEXT" ? " chosen" : "")} onClick={() => setKind("TEXT")}># text</label>
        <label className={"kind-choice" + (kind === "VOICE" ? " chosen" : "")} onClick={() => setKind("VOICE")}>🔊 voice</label>
      </div>
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
        placeholder={kind === "TEXT" ? "new-channel" : "General Voice"}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || name.trim().length === 0} onClick={() => void submit()}>Create</button>
      </div>
    </Modal>
  );
}

function RenameChannelModal({ session, channel, onClose }: {
  session: ConnectionSession;
  channel: Channel;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === channel.name) {
      if (trimmed === channel.name) {
        onClose();
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.renameChannel(channel.id, trimmed);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rename #${channel.name}`} onClose={onClose}>
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
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || name.trim().length === 0} onClick={() => void submit()}>Rename</button>
      </div>
    </Modal>
  );
}

function DeleteChannelModal({ session, channel, onClose }: {
  session: ConnectionSession;
  channel: Channel;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.deleteChannel(channel.id);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete #${channel.name}?`} onClose={onClose}>
      <div className="modal-note">This deletes the channel and its message history on the server. There is no undo.</div>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy} onClick={() => void submit()}>Delete</button>
      </div>
    </Modal>
  );
}
