import { useMemo, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, openDm, setFriendsTab, settingsStore } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { DmChannel, Relationship } from "../../types";
import { dmDisplayName, dmPreviewText } from "../../domain/logic/dm-display";
import { Avatar } from "./Avatar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";

/**
 * The Home-mode sidebar: the Friends entry + the DM list (lastMessageAt desc —
 * the store keeps the server order). Rows carry the context menu (group add /
 * rename / leave / close, 1:1 close) and the unread badge (every DM unread is
 * mention-red — the oak rule).
 */
export function DmSidebar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const dms = useStore(session.socialStore, (state) => state.dms);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const readStates = useStore(session.readStateStore, (states) => states);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  // Live badge toggle (oak's onApplied badge rebuild) — see Sidebar.
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  // Derived arrays live OUTSIDE selectors — a fresh array per getSnapshot call
  // is an infinite re-render under useSyncExternalStore.
  const friends = useMemo(
    () => relationships.filter((entry) => entry.type === "FRIEND"),
    [relationships],
  );
  const [menu, setMenu] = useState<{ dm: DmChannel; x: number; y: number } | null>(null);
  const [createGroup, setCreateGroup] = useState(false);
  const [addToGroup, setAddToGroup] = useState<DmChannel | null>(null);
  const [renameTarget, setRenameTarget] = useState<DmChannel | null>(null);

  const openMenu = (dm: DmChannel) => (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ dm, x: event.clientX, y: event.clientY });
  };
  const leaveGroup = (dm: DmChannel): void => {
    const selfId = session.selfUserId();
    if (selfId !== null) {
      void session.removeDmParticipant(dm.id, selfId);
    }
  };
  const menuItems: ContextMenuItem[] = menu === null ? [] : menu.dm.type === "GROUP_DM"
    ? [
        { label: "Add member…", action: () => setAddToGroup(menu.dm) },
        { label: "Rename…", action: () => setRenameTarget(menu.dm) },
        { label: "Leave group", danger: true, action: () => leaveGroup(menu.dm) },
        ...(menu.dm.ownerId !== null && menu.dm.ownerId === session.selfUserId()
          ? [{ label: "Close group", danger: true, action: () => void session.closeDm(menu.dm.id) }]
          : []),
      ]
    : [{ label: "Close DM", danger: true, action: () => void session.closeDm(menu.dm.id) }];

  return (
    <>
      <div className="sidebar-section-title">
        <span>Direct Messages</span>
        <button
          className="section-add"
          title="Start a group DM"
          disabled={friends.length < 2}
          onClick={() => setCreateGroup(true)}
        >+</button>
      </div>
      <div
        className={"channel-row friends-entry" + (activeDmId === null ? " active" : "")}
        onClick={() => setFriendsTab(appStore.getSnapshot().friendsTab === "ADD_FRIEND" ? "ADD_FRIEND" : appStore.getSnapshot().friendsTab)}
      >
        <span className="icon mdi-account-multiple" />
        <span className="channel-name">Friends</span>
      </div>
      {dms.map((dm) => {
        const name = dmDisplayName(dm, ownUsername);
        const unread = readStates.get(dm.id);
        const badgeCount = unread?.unreadCount ?? 0;
        return (
          <div
            key={dm.id}
            className={"dm-row" + (dm.id === activeDmId ? " active" : "")}
            onClick={() => openDm(dm.id)}
            onContextMenu={openMenu(dm)}
          >
            {dm.type === "GROUP_DM" ? (
              <span className="avatar avatar-fallback dm-group-avatar">{name.charAt(0).toUpperCase()}</span>
            ) : (
              <Avatar
                session={session}
                username={name}
                size={26}
                override={dm.participants.find((participant) => participant.username === name) ?? null}
              />
            )}
            <div className="dm-text">
              <span className="dm-name">{name}</span>
              <span className="dm-preview">{dmPreviewText(dm)}</span>
            </div>
            {badgeEnabled && badgeCount > 0 ? (
              <span className="channel-badge mention">{badgeCount > 99 ? "99+" : badgeCount}</span>
            ) : null}
          </div>
        );
      })}
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
      {createGroup ? (
        <FriendPickerModal
          session={session}
          title="Start a group DM"
          hint="Pick at least 2 friends — you are the owner."
          confirmLabel="Create"
          minimum={2}
          candidates={friends}
          exclude={[]}
          onClose={() => setCreateGroup(false)}
          onConfirm={async (selected) => {
            const dm = await session.createGroupDm(selected.map((entry) => entry.userId));
            openDm(dm.id);
          }}
        />
      ) : null}
      {addToGroup !== null ? (
        <FriendPickerModal
          session={session}
          title="Add to group"
          hint="Pick a friend to add."
          confirmLabel="Add"
          minimum={1}
          candidates={friends}
          exclude={addToGroup.participants.map((participant) => participant.id)}
          onClose={() => setAddToGroup(null)}
          onConfirm={async (selected) => {
            for (const entry of selected) {
              await session.addDmParticipant(addToGroup.id, entry.userId);
            }
          }}
        />
      ) : null}
      {renameTarget !== null ? (
        <RenameGroupModal session={session} dm={renameTarget} onClose={() => setRenameTarget(null)} />
      ) : null}
    </>
  );
}

/** Checkbox picker over the FRIEND list (group creation + adding members). */
function FriendPickerModal({ session, title, hint, confirmLabel, minimum, candidates, exclude, onClose, onConfirm }: {
  session: ConnectionSession;
  title: string;
  hint: string;
  confirmLabel: string;
  minimum: number;
  candidates: readonly Relationship[];
  exclude: readonly number[];
  onClose: () => void;
  onConfirm(selected: readonly Relationship[]): Promise<void>;
}): React.JSX.Element {
  const pool = candidates.filter((entry) => !exclude.includes(entry.userId));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (userId: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (busy || selected.size < minimum) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pool.filter((entry) => selected.has(entry.userId)));
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-note">{pool.length === 0 ? "No friends to pick." : hint}</div>
      <div className="friend-picker-list">
        {pool.map((entry) => (
          <label key={entry.userId} className={"friend-picker-row" + (selected.has(entry.userId) ? " chosen" : "")}>
            <input type="checkbox" checked={selected.has(entry.userId)} onChange={() => toggle(entry.userId)} />
            <Avatar session={session} username={entry.username} size={24} override={entry} />
            <span>{entry.username}</span>
          </label>
        ))}
      </div>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || selected.size < minimum} onClick={() => void submit()}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function RenameGroupModal({ session, dm, onClose }: {
  session: ConnectionSession;
  dm: DmChannel;
  onClose: () => void;
}): React.JSX.Element {
  const currentName = dm.name.trim().length > 0 ? dm.name : dmDisplayName(dm, session.username());
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === currentName) {
      if (trimmed === currentName) {
        onClose();
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.renameDm(dm.id, trimmed);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Rename group" onClose={onClose}>
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
