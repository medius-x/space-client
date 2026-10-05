import { useMemo, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, connectionDirectory, openDm, openDmOnInstance, setFriendsTab, settingsStore } from "../runtime";
import { socialDirectory } from "../social-aggregate";
import { mergeDmRows, type DmRowModel } from "../../domain/logic/social-aggregation";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { DmChannel, Relationship } from "../../types";
import { dmDisplayName, dmPreviewText } from "../../domain/logic/dm-display";
import { paletteColor } from "../../domain/logic/user-palette";
import { Avatar } from "./Avatar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { InstanceTag } from "./InstanceTag";
import { Modal } from "./Modal";

/**
 * The Home-mode sidebar: the Friends entry + the DM list, AGGREGATED across
 * every saved instance (oak's rebuildDmList): rows of the active instance open
 * in place; rows of other instances carry an instance tag and switch there
 * first. Rows carry the context menu (group add/rename/leave/close, 1:1 close)
 * and the unread badge (every DM unread is mention-red — the oak rule; hidden
 * on the open conversation).
 */
export function DmSidebar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const dms = useStore(session.socialStore, (state) => state.dms);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const readStates = useStore(session.readStateStore, (states) => states);
  const backgroundAll = useStore(socialDirectory, (snapshots) => snapshots);
  // The ACTIVE record's own snapshot must never merge with its live rows — its
  // keys would duplicate and orphan React nodes (live report: stale dm-rows
  // stacked above the channel list). The directory drops the entry on
  // activation, but the coalesced 1 s rebuild makes this belt worth having.
  // Filtered OUTSIDE the selector: a fresh array per selector call would loop
  // useSyncExternalStore (the M6 lesson).
  const background = useMemo(
    () => backgroundAll.filter((entry) => entry.recordId !== session.recordId),
    [backgroundAll, session.recordId],
  );
  const record = useStore(connectionDirectory, (records) =>
    records.find((entry) => entry.id === session.recordId) ?? null);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  // Live badge toggle (oak's onApplied badge rebuild) — see Sidebar.
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const friends = useMemo(
    () => relationships.filter((entry) => entry.type === "FRIEND"),
    [relationships],
  );
  const [menu, setMenu] = useState<{ row: DmRowModel; x: number; y: number } | null>(null);
  const [createGroup, setCreateGroup] = useState(false);
  const [notEnoughFriends, setNotEnoughFriends] = useState(false);
  const [addToGroup, setAddToGroup] = useState<DmChannel | null>(null);
  const [renameTarget, setRenameTarget] = useState<DmChannel | null>(null);

  const serverName = record?.cachedServerName ?? session.hostUrl();
  const serverAvatar = session.serverProfile !== null && session.serverProfile.avatarKey !== null && session.serverProfile.avatarUrl !== null
    ? { key: session.serverProfile.avatarKey, url: session.serverProfile.avatarUrl }
    : null;
  const rows = useMemo(
    () => mergeDmRows(
      {
        recordId: session.recordId,
        serverName,
        serverAvatar,
        selfUsername: ownUsername,
        dms,
        unreadOf: (dm) => ({
          unread: readStates.get(dm.id)?.unreadCount ?? 0,
          mention: readStates.get(dm.id)?.mentionCount ?? 0,
        }),
      },
      background,
    ),
    [session.recordId, serverName, serverAvatar, ownUsername, dms, readStates, background],
  );

  const leaveGroup = (dm: DmChannel): void => {
    const selfId = session.selfUserId();
    if (selfId !== null) {
      void session.removeDmParticipant(dm.id, selfId);
    }
  };

  // oak: the group/DM mutations are scoped to the ACTIVE instance — rows of
  // other instances get no context menu at all (a plain click switches first).
  const menuRow = menu !== null && menu.row.active ? menu.row : null;
  const isOwner = menuRow !== null && menuRow.dm.ownerId !== null && menuRow.dm.ownerId === session.selfUserId();
  const menuItems: ContextMenuItem[] = menuRow === null ? [] : menuRow.dm.type === "GROUP_DM"
    ? [
        // Add member is the OWNER's tool in oak; Rename is everyone's.
        ...(isOwner ? [{ label: "Add member…", action: () => setAddToGroup(menuRow.dm) }] : []),
        { label: "Rename…", action: () => setRenameTarget(menuRow.dm) },
        { label: "", separator: true, action: () => undefined },
        { label: "Leave group", danger: true, action: () => leaveGroup(menuRow.dm) },
        ...(isOwner
          ? [{ label: "Close group", danger: true, action: () => void session.closeDm(menuRow.dm.id) }]
          : []),
      ]
    : [{ label: "Close DM", danger: true, action: () => void session.closeDm(menuRow.dm.id) }];

  // A restricted member (RESTRICT_PRIVATE_MESSAGES) cannot start groups either.
  const myDmRestricted = useStore(session.permissionStore, (state) => state.my?.dmRestricted === true);

  return (
    <>
      <div className="sidebar-section-title">
        <span>Direct Messages</span>
        {!myDmRestricted ? (
          <button
            className="section-add"
            title="Start a group DM"
            onClick={() => (friends.length < 2 ? setNotEnoughFriends(true) : setCreateGroup(true))}
          >+</button>
        ) : null}
      </div>
      <div
        className={"channel-row friends-entry" + (activeDmId === null ? " active" : "")}
        onClick={() => setFriendsTab(appStore.getSnapshot().friendsTab === "ADD_FRIEND" ? "ADD_FRIEND" : appStore.getSnapshot().friendsTab)}
      >
        <span className="icon mdi-account-multiple" />
        <span className="channel-name">Friends</span>
      </div>
      {rows.map((row) => {
        const name = dmDisplayName(row.dm, row.selfUsername);
        const selected = row.active && row.dm.id === activeDmId;
        const showBadge = badgeEnabled && row.unread > 0 && !selected;
        const peerOverride = row.dm.participants.find((participant) => participant.username !== row.selfUsername)
          ?? row.dm.participants[0] ?? null;
        return (
          <div
            key={`${row.recordId}:${row.dm.id}`}
            className={"dm-row" + (selected ? " active" : "")}
            onClick={() => (row.active ? openDm(row.dm.id) : openDmOnInstance(row.recordId, row.dm.id))}
            onContextMenu={row.active ? (event) => {
              event.preventDefault();
              setMenu({ row, x: event.clientX, y: event.clientY });
            } : undefined}
          >
            {/* session=null for EVERY row: all DM avatars load through the ONE
                shared dormant cache, so promoting a record never swaps the
                loading path under them (the fallback flash, live report). */}
            {row.dm.type === "GROUP_DM" ? (
              <span
                className="avatar avatar-fallback dm-group-avatar"
                style={{ background: paletteColor(name), fontSize: 14 }}
              >
                {name.trim().length === 0 ? "?" : name.trim().slice(0, 2).toUpperCase()}
              </span>
            ) : (
              <Avatar session={null} username={name} size={36} override={peerOverride} />
            )}
            <div className="dm-text">
              <span className="dm-name">{name}</span>
              <span className="dm-preview">{dmPreviewText(row.dm)}</span>
            </div>
            <InstanceTag serverName={row.serverName} icon={row.serverAvatar} />
            {showBadge ? (
              <span className="channel-badge mention">{row.unread > 99 ? "99+" : row.unread}</span>
            ) : null}
          </div>
        );
      })}
      {menuRow !== null && menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      {notEnoughFriends ? (
        <Modal title="Not enough friends" onClose={() => setNotEnoughFriends(false)}>
          <div className="modal-note">You need at least 2 friends to start a group DM.</div>
          <div className="modal-actions">
            <button className="primary" onClick={() => setNotEnoughFriends(false)}>OK</button>
          </div>
        </Modal>
      ) : null}
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Restricted members cannot be added to a group (the server 403s; the picker
  // keeps the list honest) — both usages: group creation and "Add member…".
  // Derived OUTSIDE the selector (the M6 identity trap: filter/map in a
  // selector loops useSyncExternalStore).
  const members = useStore(session.memberStore, (state) => state.members);
  const restrictedIds = useMemo(
    () => members.filter((member) => member.dmRestricted === true).map((member) => member.userId),
    [members],
  );
  const pool = useMemo(
    () => candidates.filter((entry) => !exclude.includes(entry.userId) && !restrictedIds.includes(entry.userId)),
    [candidates, exclude, restrictedIds],
  );

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
      <div className="modal-note">Enter a new name for this group DM.</div>
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
