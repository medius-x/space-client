import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, openDmWithUser, setFriendsTab, type FriendsTab } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Relationship, RelationshipType } from "../../types";
import { Avatar } from "./Avatar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/**
 * The Friends pane (oak's four tabs + Add Friend). Every row action is a REST call
 * followed by the coalesced relationship refresh — the actor gets no push back.
 */
const TABS: { key: Exclude<FriendsTab, "ADD_FRIEND">; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "ONLINE", label: "Online" },
  { key: "PENDING", label: "Pending" },
  { key: "BLOCKED", label: "Blocked" },
];

const STATUS_TEXT: Record<RelationshipType, string> = {
  FRIEND: "Online",
  BLOCKED: "Blocked",
  PENDING_INCOMING: "Incoming friend request",
  PENDING_OUTGOING: "Outgoing friend request",
};

export function FriendsPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const tab = useStore(appStore, (state) => state.friendsTab);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const presence = useStore(session.rosterStore, (state) => state.presence);

  const sorted = [...relationships].sort((left, right) => left.username.localeCompare(right.username));
  const friends = sorted.filter((entry) => entry.type === "FRIEND");
  const lists: Record<Exclude<FriendsTab, "ADD_FRIEND">, { label: string | null; rows: Relationship[] }[]> = {
    ALL: [{ label: null, rows: friends }],
    ONLINE: [{ label: null, rows: friends.filter((entry) => presence.has(entry.username)) }],
    PENDING: [
      { label: "Incoming", rows: sorted.filter((entry) => entry.type === "PENDING_INCOMING") },
      { label: "Outgoing", rows: sorted.filter((entry) => entry.type === "PENDING_OUTGOING") },
    ],
    BLOCKED: [{ label: null, rows: sorted.filter((entry) => entry.type === "BLOCKED") }],
  };

  return (
    <div className="friends-pane">
      <div className="friends-header">
        <span className="friends-title">👥 Friends</span>
        <div className="friends-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              className={"friends-tab" + (tab === entry.key ? " active" : "")}
              onClick={() => setFriendsTab(entry.key)}
            >
              {entry.label}
              {entry.key === "PENDING" && lists.PENDING[0]!.rows.length + lists.PENDING[1]!.rows.length > 0 ? (
                <span className="tab-counter">{lists.PENDING[0]!.rows.length + lists.PENDING[1]!.rows.length}</span>
              ) : null}
            </button>
          ))}
          <button
            className={"friends-tab add-friend" + (tab === "ADD_FRIEND" ? " active" : "")}
            onClick={() => setFriendsTab("ADD_FRIEND")}
          >
            Add Friend
          </button>
        </div>
      </div>
      <div className="friends-body">
        {tab === "ADD_FRIEND" ? (
          <AddFriendForm session={session} />
        ) : lists[tab].every((section) => section.rows.length === 0) ? (
          <div className="friends-empty">{emptyText(tab)}</div>
        ) : (
          lists[tab].map((section) =>
            section.rows.length === 0 ? null : (
              <div key={section.label ?? "only"}>
                {section.label !== null ? (
                  <div className="friends-section">{section.label} — {section.rows.length}</div>
                ) : null}
                {section.rows.map((entry) => (
                  <FriendRow key={entry.userId} session={session} relationship={entry} online={presence.has(entry.username)} />
                ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

function emptyText(tab: Exclude<FriendsTab, "ADD_FRIEND">): string {
  switch (tab) {
    case "ALL":
      return "No friends yet.";
    case "ONLINE":
      return "No friends online.";
    case "PENDING":
      return "No pending requests.";
    case "BLOCKED":
      return "No blocked users.";
  }
}

function FriendRow({ session, relationship, online }: {
  session: ConnectionSession;
  relationship: Relationship;
  online: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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

  const statusText = relationship.type === "FRIEND" ? (online ? "Online" : "Offline") : STATUS_TEXT[relationship.type];
  const menuItems: ContextMenuItem[] = [
    { label: "Remove friend", danger: true, action: () => void run(() => session.removeFriend(relationship.userId)) },
    { label: "Block", danger: true, action: () => void run(() => session.blockUser(relationship.username)) },
  ];

  return (
    <div className="friend-row">
      <span className={"presence-dot" + (relationship.type === "FRIEND" && online ? " online" : "")} />
      <Avatar session={session} username={relationship.username} size={32} override={relationship} />
      <div className="friend-info">
        <span className="friend-name">{relationship.username}</span>
        <span className="friend-status">{statusText}</span>
        {error !== null ? <span className="friend-error">{error}</span> : null}
      </div>
      {relationship.type === "FRIEND" ? (
        <>
          <button className="ghost friend-action" disabled={busy} onClick={() => void run(() => openDmWithUser(relationship.userId))}>
            Message
          </button>
          <button className="ghost friend-action" disabled={busy} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}>⋯</button>
        </>
      ) : relationship.type === "PENDING_INCOMING" ? (
        <>
          <button className="primary friend-action" disabled={busy} onClick={() => void run(() => session.acceptFriendRequest(relationship.userId))}>
            Accept
          </button>
          <button className="ghost friend-action" disabled={busy} onClick={() => void run(() => session.removeFriend(relationship.userId))}>
            Decline
          </button>
        </>
      ) : relationship.type === "PENDING_OUTGOING" ? (
        <button className="ghost friend-action" disabled={busy} onClick={() => void run(() => session.removeFriend(relationship.userId))}>
          Cancel
        </button>
      ) : (
        <button className="ghost friend-action" disabled={busy} onClick={() => void run(() => session.unblockUser(relationship.userId))}>
          Unblock
        </button>
      )}
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

function AddFriendForm({ session }: { session: ConnectionSession }): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = username.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setStatus("Sending…");
    try {
      await session.sendFriendRequest(trimmed);
      setStatus(`Friend request sent to ${trimmed}.`); // mutual pending auto-accepts
      setUsername("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-friend-form">
      <div className="add-friend-title">ADD A FRIEND</div>
      <div className="add-friend-hint">You can add friends by their username.</div>
      <div className="add-friend-row">
        <input
          autoFocus
          type="text"
          value={username}
          placeholder="Enter a username"
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }}
        />
        <button className="primary" disabled={busy || username.trim().length === 0} onClick={() => void submit()}>
          Send Friend Request
        </button>
      </div>
      {status !== null ? <div className="add-friend-status">{status}</div> : null}
    </div>
  );
}
