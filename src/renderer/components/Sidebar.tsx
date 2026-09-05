import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, connectionDirectory, joinVoiceGuarded, setActiveChannel } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Channel } from "../../types";
import { MANAGE_CHANNELS_PERMISSION } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { VoiceMarks } from "./VoiceRoom";
import { DmSidebar } from "./DmSidebar";

/**
 * The channel column (oak's 220px channel-pane). Channel CRUD lives in the
 * context menu (right-click) and the section "+" buttons; the member roster is
 * NOT here anymore — it is its own right-hand column (MembersPane, oak parity).
 */
export function Sidebar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const roster = useStore(session.rosterStore, (roster) => roster);
  const readStates = useStore(session.readStateStore, (states) => states);
  const voiceMarks = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const canManageChannels = useStore(session.permissionStore, (state) => state.my?.permissions.includes(MANAGE_CHANNELS_PERMISSION) ?? false);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);

  const [menu, setMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null);
  const [createType, setCreateType] = useState<"TEXT" | "VOICE" | null>(null);
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);

  const textChannels = channels.filter((channel) => channel.type === "TEXT");
  const voiceChannels = channels.filter((channel) => channel.type === "VOICE");

  const onTextChannelClick = (channel: Channel) => {
    if (!channel.locked) {
      setActiveChannel(channel.id);
    }
  };
  const onVoiceChannelClick = (channel: Channel) => {
    if (channel.id !== activeVoiceChannelId) {
      joinVoiceGuarded(channel); // asks about ending a live call first
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
      {dmMode ? (
        <DmSidebar session={session} />
      ) : (
        <>
          <div className="sidebar-server-header">
            {connectionDirectory.get(session.recordId)?.cachedServerName ?? session.hostUrl().replace(/^https?:\/\//, "")}
          </div>
          <div className="sidebar-section-title">
            <span>Channels</span>
            {canManageChannels ? (
              <button className="section-add" title="Create channel" onClick={() => setCreateType("TEXT")}>+</button>
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
                <span className="icon mdi-pound channel-glyph" />
                <span className="channel-name">{channel.name}</span>
                {unread !== undefined && unread.unreadCount > 0 ? (
                  <span className={"channel-badge" + (unread.mentionCount > 0 ? " mention" : "")}>
                    {unread.unreadCount > 99 ? "99+" : unread.unreadCount}
                  </span>
                ) : null}
              </div>
            );
          })}
          {voiceChannels.map((channel) => (
            <div key={channel.id}>
              <div
                className={"channel-row"
                  + (channel.id === activeVoiceChannelId ? " active voice-live" : "")
                  + (channel.locked ? " locked" : "")}
                onClick={() => onVoiceChannelClick(channel)}
                onContextMenu={openMenu(channel)}
              >
                <span className="icon mdi-volume-high channel-glyph" />
                <span className="channel-name">{channel.name}</span>
              </div>
              {[...(roster.voiceMembers.get(channel.id) ?? [])].map((username) => (
                <div key={username} className="voice-member-row">
                  <Avatar session={session} username={username} size={20} />
                  <span className="member-name">{username}{username === ownUsername ? " (you)" : ""}</span>
                  <VoiceMarks marks={voiceMarks.get(username)} />
                </div>
              ))}
            </div>
          ))}
        </>
      )}

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
        <label className={"kind-choice" + (kind === "TEXT" ? " chosen" : "")} onClick={() => setKind("TEXT")}><span className="icon mdi-pound" /> text</label>
        <label className={"kind-choice" + (kind === "VOICE" ? " chosen" : "")} onClick={() => setKind("VOICE")}><span className="icon mdi-volume-high" /> voice</label>
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
