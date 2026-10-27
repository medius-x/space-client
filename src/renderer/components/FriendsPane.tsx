import { useMemo, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  connectionDirectory,
  openDmWithUser,
  setFriendsTab,
  switchConnection,
  type FriendsTab,
} from "../runtime";
import { socialDirectory } from "../social-aggregate";
import { mergeFriendRows, type FriendRowModel } from "../../domain/logic/social-aggregation";
import { dmBlockHintText } from "../../domain/logic/dm-gating";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { UserSummary } from "../../types";
import { Avatar } from "./Avatar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { InstanceTag } from "./InstanceTag";
import { Modal } from "./Modal";
import { useT } from "../hooks/useT";
import type { Translator } from "../../domain/i18n/i18n";

/**
 * The Friends pane (oak's four tabs + Add Friend), AGGREGATED across every
 * saved instance: the active session's rows carry the full actions, rows of
 * other instances render read-only with an instance tag and an "Open" button
 * (REST snapshots — see social-aggregate). Every active-instance row action is
 * a REST call followed by the coalesced relationship refresh; the actor gets
 * no push back.
 */
const TABS: Exclude<FriendsTab, "ADD_FRIEND">[] = ["ALL", "ONLINE", "PENDING", "BLOCKED"];

const TAB_LABEL_KEYS: Record<Exclude<FriendsTab, "ADD_FRIEND">, "friends.tab.all" | "friends.tab.online" | "friends.tab.pending" | "friends.tab.blocked"> = {
  ALL: "friends.tab.all",
  ONLINE: "friends.tab.online",
  PENDING: "friends.tab.pending",
  BLOCKED: "friends.tab.blocked",
};

export function FriendsPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const tab = useStore(appStore, (state) => state.friendsTab);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const presence = useStore(session.rosterStore, (state) => state.presence);
  const backgroundAll = useStore(socialDirectory, (snapshots) => snapshots);
  const record = useStore(connectionDirectory, (records) =>
    records.find((entry) => entry.id === session.recordId) ?? null);
  // The ACTIVE record's own snapshot must never merge with its live rows —
  // duplicate keys orphan React nodes (see DmSidebar; the directory drops the
  // entry on activation, this belt covers the coalesced-rebuild window).
  // Filtered OUTSIDE the selector — a fresh array per call loops
  // useSyncExternalStore (the M6 lesson).
  const background = useMemo(
    () => backgroundAll.filter((entry) => entry.recordId !== session.recordId),
    [backgroundAll, session.recordId],
  );

  const rows = useMemo(
    () => mergeFriendRows(
      {
        recordId: session.recordId,
        serverName: record?.cachedServerName ?? session.hostUrl(),
        serverAvatar: session.serverProfile !== null && session.serverProfile.avatarKey !== null && session.serverProfile.avatarUrl !== null
          ? { key: session.serverProfile.avatarKey, url: session.serverProfile.avatarUrl }
          : null,
        relationships,
        onlineUsernames: presence,
      },
      background,
    ),
    [session.recordId, record, relationships, presence, background, session.serverProfile],
  );

  const friends = rows.filter((row) => row.relationship.type === "FRIEND");
  const lists: Record<Exclude<FriendsTab, "ADD_FRIEND">, { label: string | null; rows: FriendRowModel[] }[]> = {
    ALL: [{ label: null, rows: friends }],
    ONLINE: [{ label: null, rows: friends.filter((row) => row.online) }],
    PENDING: [
      { label: t("friends.section.incoming"), rows: rows.filter((row) => row.relationship.type === "PENDING_INCOMING") },
      { label: t("friends.section.outgoing"), rows: rows.filter((row) => row.relationship.type === "PENDING_OUTGOING") },
    ],
    BLOCKED: [{ label: null, rows: rows.filter((row) => row.relationship.type === "BLOCKED") }],
  };
  const pendingTotal = lists.PENDING[0]!.rows.length + lists.PENDING[1]!.rows.length;

  return (
    <div className="friends-pane">
      <div className="friends-header">
        <span className="friends-title"><span className="icon mdi-account-multiple" /> {t("dm.friends")}</span>
        <div className="friends-tabs">
          {TABS.map((tabKey) => (
            <button
              key={tabKey}
              className={"friends-tab" + (tab === tabKey ? " active" : "")}
              onClick={() => setFriendsTab(tabKey)}
            >
              {t(TAB_LABEL_KEYS[tabKey])}
              {tabKey === "PENDING" && pendingTotal > 0 ? (
                <span className="tab-counter">{pendingTotal}</span>
              ) : null}
            </button>
          ))}
          <button
            className={"friends-tab add-friend" + (tab === "ADD_FRIEND" ? " active" : "")}
            onClick={() => setFriendsTab("ADD_FRIEND")}
          >
            {t("friends.addFriendTab")}
          </button>
        </div>
      </div>
      <div className="friends-body">
        {tab === "ADD_FRIEND" ? (
          <AddFriendForm session={session} />
        ) : lists[tab].every((section) => section.rows.length === 0) ? (
          <div className="friends-empty">{emptyText(t, tab)}</div>
        ) : (
          lists[tab].map((section) =>
            section.rows.length === 0 ? null : (
              <div key={section.label ?? "only"}>
                {section.label !== null ? (
                  <div className="friends-section">{section.label} — {section.rows.length}</div>
                ) : null}
                {section.rows.map((row) => (
                  <FriendRow key={`${row.recordId}:${row.relationship.userId}`} session={session} row={row} />
                ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

function emptyText(t: Translator, tab: Exclude<FriendsTab, "ADD_FRIEND">): string {
  switch (tab) {
    case "ALL":
      return t("friends.empty.all");
    case "ONLINE":
      return t("friends.empty.online");
    case "PENDING":
      return t("friends.empty.pending");
    case "BLOCKED":
      return t("friends.empty.blocked");
  }
}

function FriendRow({ session, row }: { session: ConnectionSession; row: FriendRowModel }): React.JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The destructive action awaiting the user's confirmation (oak fires these
   *  straight from the menu; the confirm step is this client's addition). */
  const [confirmKind, setConfirmKind] = useState<"remove" | "block" | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  };

  const relationship = row.relationship;
  const statusText = relationship.type === "FRIEND"
    ? (row.online ? t("friends.status.online") : t("friends.status.offline"))
    : relationship.type === "BLOCKED"
      ? t("friends.status.blocked")
      : relationship.type === "PENDING_INCOMING"
        ? t("friends.status.pendingIncoming")
        : t("friends.status.pendingOutgoing");
  // The DM restriction (RESTRICT_PRIVATE_MESSAGES): the Message button explains
  // itself instead of firing a doomed 403 — either I am barred, or the friend is.
  const myDmRestricted = useStore(session.permissionStore, (state) => state.my?.dmRestricted === true);
  const peerDmRestricted = useStore(session.memberStore, (state) =>
    state.members.find((member) => member.userId === relationship.userId)?.dmRestricted === true);
  const messageBlockedTitle = myDmRestricted || peerDmRestricted
    ? dmBlockHintText(myDmRestricted ? "self" : "peer")
    : undefined;
  // oak's "⋮" card rows are plain action rows — no danger tint. Both actions
  // open a confirmation first, the REST call fires only on the confirm button.
  const menuItems: ContextMenuItem[] = [
    { label: t("friends.removeFriend"), action: () => setConfirmKind("remove") },
    { label: t("friends.block"), action: () => setConfirmKind("block") },
  ];

  return (
    <div className="list-row">
      <span className={"presence-dot" + (relationship.type === "FRIEND" && row.online ? " online" : "")} />
      {/* session=null for EVERY row: all friend avatars load through the ONE
          shared dormant cache, so promoting a record never swaps the loading
          path under them (the fallback flash, live report). */}
      <Avatar session={null} username={relationship.username} size={40} override={relationship} />
      <div className="friend-info">
        <span className="friend-name">{relationship.displayName ?? relationship.username}</span>
        <span className="friend-status">{statusText}</span>
        {error !== null ? <span className="friend-error">{error}</span> : null}
      </div>
      <InstanceTag serverName={row.serverName} icon={row.serverAvatar} />
      {row.active ? (
        <>
          {relationship.type === "FRIEND" ? (
            <>
              <button
                className="friend-action"
                disabled={busy || messageBlockedTitle !== undefined}
                title={messageBlockedTitle}
                onClick={() => void run(() => openDmWithUser(relationship.userId))}
              >
                {t("friends.message")}
              </button>
              <button className="friend-action" disabled={busy} onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom });
              }}>⋯</button>
            </>
          ) : relationship.type === "PENDING_INCOMING" ? (
            <>
              <button className="friend-action" disabled={busy} onClick={() => void run(() => session.acceptFriendRequest(relationship.userId))}>
                {t("friends.accept")}
              </button>
              <button className="friend-action" disabled={busy} onClick={() => void run(() => session.removeFriend(relationship.userId))}>
                {t("friends.decline")}
              </button>
            </>
          ) : relationship.type === "PENDING_OUTGOING" ? (
            <button className="friend-action" disabled={busy} onClick={() => void run(() => session.removeFriend(relationship.userId))}>
              {t("common.cancel")}
            </button>
          ) : (
            <button className="friend-action" disabled={busy} onClick={() => void run(() => session.unblockUser(relationship.userId))}>
              {t("friends.unblock")}
            </button>
          )}
        </>
      ) : (
        // oak: rows of OTHER instances only offer switching to them — the
        // friend/DM mutations are scoped to that instance's active connection.
        <button className="friend-action" onClick={() => void switchConnection(row.recordId)}>
          {t("friends.openServer", { server: row.serverName })}
        </button>
      )}
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      {confirmKind !== null ? (
        <Modal
          title={confirmKind === "remove" ? t("friends.removeFriend") : t("friends.block")}
          onClose={() => setConfirmKind(null)}
        >
          <div className="modal-note">
            {confirmKind === "remove"
              ? t("friends.removeFriendConfirm", { name: relationship.displayName ?? relationship.username })
              : t("friends.blockConfirm", { name: relationship.displayName ?? relationship.username })}
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setConfirmKind(null)}>{t("common.cancel")}</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                const kind = confirmKind;
                setConfirmKind(null);
                void run(() => kind === "remove"
                  ? session.removeFriend(relationship.userId)
                  : session.blockUser(relationship.username));
              }}
            >
              {confirmKind === "remove" ? t("friends.removeFriend") : t("friends.block")}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function AddFriendForm({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const users = useStore(session.rosterStore, (state) => state.users);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);

  // oak's autocomplete, walked by NICKNAME (the rename model: friends are
  // addressed by the one visible name; the login never matches).
  const suggestions = useMemo(() => {
    const query = username.trim().toLowerCase();
    if (query.length === 0) {
      return [];
    }
    return users
      .filter((user) => user.username !== ownUsername)
      .filter((user) => (user.displayName ?? user.username).toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [username, users, ownUsername]);

  const applySuggestion = (picked: UserSummary): void => {
    setUsername(picked.displayName ?? picked.username);
    setSuggestIndex(0);
  };

  const submit = async (): Promise<void> => {
    const trimmed = username.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setStatus(t("friends.sending"));
    try {
      await session.sendFriendRequest(trimmed);
      setStatus(t("friends.requestSent", { name: trimmed })); // mutual pending auto-accepts
      setUsername("");
      setSuggestIndex(0);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-friend-form">
      <div className="add-friend-title">{t("friends.addTitle")}</div>
      <div className="add-friend-hint">{t("friends.addHint")}</div>
      <div className="add-friend-entry">
        {suggestions.length > 0 ? (
          <div className="username-suggest">
            {suggestions.map((user, index) => (
              <div
                key={user.id}
                className={"mention-row" + (index === suggestIndex ? " chosen" : "")}
                onClick={() => applySuggestion(user)}
              >
                <Avatar session={session} username={user.username} size={20} />
                <span>{user.displayName ?? user.username}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="add-friend-row">
          <input
            autoFocus
            type="text"
            value={username}
            placeholder={t("friends.addPlaceholder")}
            onChange={(event) => {
              setUsername(event.target.value);
              setSuggestIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && suggestions.length > 0) {
                event.preventDefault();
                setSuggestIndex((index) => (index + 1) % suggestions.length);
              } else if (event.key === "ArrowUp" && suggestions.length > 0) {
                event.preventDefault();
                setSuggestIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
              } else if (event.key === "Enter") {
                if (suggestions.length > 0 && suggestIndex < suggestions.length) {
                  event.preventDefault();
                  applySuggestion(suggestions[suggestIndex]!);
                } else {
                  void submit();
                }
              } else if (event.key === "Escape" && suggestions.length > 0) {
                setSuggestIndex(0);
                setUsername("");
              }
            }}
          />
          <button className="primary" disabled={busy || username.trim().length === 0} onClick={() => void submit()}>
            {t("friends.sendRequest")}
          </button>
        </div>
      </div>
      {status !== null ? <div className="add-friend-status">{status}</div> : null}
    </div>
  );
}
