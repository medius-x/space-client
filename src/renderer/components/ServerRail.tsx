import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import {
  appStore,
  beginAddServer,
  canManageServerSettings,
  connectionDirectory,
  exitHomeMode,
  openServerSettings,
  reloginConnection,
  removeConnection,
  settingsStore,
  switchConnection,
  toggleHomeMode,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { ConnectionRecord } from "../../domain/session/connection-record";
import { EXPIRED_MARKER } from "../../domain/session/connection-record";
import type { SocialState } from "../../domain/stores/SocialStore";
import type { UnreadState } from "../../domain/stores/ReadStateStore";
import { paletteColor } from "../../domain/logic/user-palette";
import { serverInitials } from "../../domain/logic/server-initials";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { socialDirectory } from "../social-aggregate";

/** Stable EMPTY store surrogates for the non-active rows — useStore needs a
 *  live store on every branch (hook rules). */
const EMPTY_READ_STATES: ReadonlyMap<number, UnreadState> = new Map();
const nullReadStateStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): ReadonlyMap<number, UnreadState> => EMPTY_READ_STATES,
};
const EMPTY_SOCIAL: SocialState = { relationships: [], dms: [] };
const nullSocialStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): SocialState => EMPTY_SOCIAL,
};;

/**
 * The Discord-style server rail: the Home button (friends + DMs) on top, then
 * one squircle icon per saved connection — the server's AVATAR when it has
 * one, a palette-colored initials disc otherwise (oak's ServerNode) — then the
 * "+" row. Click switches, right-click manages, hover shows the name bubble.
 */
export function ServerRail({ activeRecordId, session }: {
  activeRecordId: string | null;
  session: ConnectionSession | null;
}): React.JSX.Element {
  const records = useStore(connectionDirectory, (records) => records);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const [menu, setMenu] = useState<{ recordId: string; x: number; y: number } | null>(null);
  // oak's reloginFor/showReloginDialog + deleteServer confirm — both ride the
  // same right-click card as everything else.
  const [reloginTarget, setReloginTarget] = useState<ConnectionRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRecord | null>(null);

  const menuItems: ContextMenuItem[] = menu === null ? [] : [
    // Gated live: without any settings permission the entry never appears (oak parity).
    ...(menu.recordId === session?.recordId && session !== null && canManageServerSettings(session)
      ? [
        { label: "Server Settings", action: () => openServerSettings() },
        // oak's single separator — between the settings entry and the rest.
        { label: "", separator: true, action: () => undefined },
      ]
      : []),
    { label: "Re-login", action: () => {
      const record = connectionDirectory.get(menu.recordId);
      if (record !== null) {
        setReloginTarget(record);
      }
    } },
    { label: "Delete", danger: true, action: () => {
      const record = connectionDirectory.get(menu.recordId);
      if (record !== null) {
        setDeleteTarget(record);
      }
    } },
  ];

  return (
    <nav className="server-rail">
      {session !== null ? <HomeRailButton session={session} /> : null}
      <div className="rail-separator" />
      {records.map((record) => (
        <RailRow
          key={record.id}
          record={record}
          active={record.id === activeRecordId && !dmMode}
          expired={record.token === EXPIRED_MARKER}
          busy={busy}
          session={session}
          onActivate={() => {
            if (record.id === activeRecordId) {
              // In Home mode the ACTIVE server icon is the "back to the server"
              // affordance — without this the click hits the same-record guard
              // and does nothing (live M6 smoke).
              exitHomeMode();
              return;
            }
            if (!busy) {
              void switchConnection(record.id);
            }
          }}
          onMenu={(x, y) => setMenu({ recordId: record.id, x, y })}
        />
      ))}
      <div className="rail-wrap" title="Add a server" onClick={beginAddServer}>
        <div className="rail-icon add"><span className="icon mdi-plus" /></div>
      </div>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      {reloginTarget !== null ? (
        <ReloginModal record={reloginTarget} onClose={() => setReloginTarget(null)} />
      ) : null}
      {deleteTarget !== null ? (
        <Modal title="Delete server" onClose={() => setDeleteTarget(null)}>
          {/* oak's ConfirmDialog wording verbatim. */}
          <div className="modal-note">
            {`Remove the connection to "${deleteTarget.cachedServerName ?? deleteTarget.hostUrl}"? The account is not affected, you can re-add it later.`}
          </div>
          <div className="modal-actions left">
            <button className="ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="danger" onClick={() => {
              void removeConnection(deleteTarget.id);
              setDeleteTarget(null);
            }}>Delete</button>
          </div>
        </Modal>
      ) : null}
    </nav>
  );
}

/** oak's showReloginDialog: one password field, "Log in", no persistence. */
function ReloginModal({ record, onClose }: {
  record: ConnectionRecord;
  onClose(): void;
}): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverName = record.cachedServerName ?? record.hostUrl.replace(/^https?:\/\//, "");

  const submit = async (): Promise<void> => {
    if (busy || password.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reloginConnection(record.id, password);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Re-login" onClose={onClose}>
      <div className="modal-note">{`Re-enter the password for "${record.username}" on ${serverName}.`}</div>
      <input
        autoFocus
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions left">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || password.length === 0} onClick={() => void submit()}>Log in</button>
      </div>
    </Modal>
  );
}

/**
 * The server icon at ANY size (the settings preview reuses it): the avatar by
 * stable key (live presigned URL for the active session) or the palette
 * initials disc — squircle-clipped like the rail.
 */
export function ServerIconPreview({ session, size }: {
  session: ConnectionSession;
  size: number;
}): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = records.find((entry) => entry.id === session.recordId) ?? null;
  const name = record?.cachedServerName ?? session.hostUrl().replace(/^https?:\/\//, "");
  const liveAvatarUrl = session.serverProfile?.avatarUrl ?? null;
  const iconUrl = useAttachmentImage(
    session,
    record?.cachedServerAvatarKey != null ? { key: record.cachedServerAvatarKey, url: liveAvatarUrl } : null,
  );
  return (
    <span className="rail-preview" style={{ width: size, height: size }}>
      <ServerIconBody iconUrl={iconUrl} name={name} />
    </span>
  );
}

/** The squircle-clipped icon content shared by the rail rows and the preview. */
function ServerIconBody({ iconUrl, name }: { iconUrl: string | null; name: string }): React.JSX.Element {
  return iconUrl !== null ? (
    <img className="rail-avatar" src={iconUrl} alt={name} draggable={false} />
  ) : (
    <span className="rail-avatar rail-avatar-fallback" style={{ background: paletteColor(name) }}>
      {serverInitials(name)}
    </span>
  );
}

/**
 * One server row: the 72×56 click wrap (oak's ServerNode) carrying the white
 * selection pill at the rail's left edge, the 48×48 squircle icon and the
 * unread badge at its bottom-right corner.
 */
function RailRow({ record, active, expired, busy, session, onActivate, onMenu }: {
  record: ConnectionRecord;
  active: boolean;
  expired: boolean;
  busy: boolean;
  session: ConnectionSession | null;
  onActivate(): void;
  onMenu(x: number, y: number): void;
}): React.JSX.Element {
  const name = record.cachedServerName ?? record.hostUrl.replace(/^https?:\/\//, "");
  // The ACTIVE record gets the live presigned URL (its own session mints it);
  // inactive records render from the disk cache keyed by the stable avatarKey.
  const liveAvatarUrl = session !== null && session.recordId === record.id
    ? session.serverProfile?.avatarUrl ?? null
    : null;
  const iconUrl = useAttachmentImage(
    session,
    record.cachedServerAvatarKey !== null ? { key: record.cachedServerAvatarKey, url: liveAvatarUrl } : null,
  );
  const badge = useServerBadge(record.id, session);

  // oak's name bubble: a Discord-style pill to the RIGHT of the icon, vertically
  // centered on it (not at the cursor) — a custom popup, never a native Tooltip.
  // Shows after 400 ms of hover, hides instantly on leave (MainController 8470-8489).
  // PORTED TO document.body: the rail scrolls (overflow-y: auto), which per CSS
  // computes overflow-x to auto too — an absolutely-positioned pill past the
  // 72px rail edge was CLIPPED, so the bubble never appeared (live report).
  const [bubbleAnchor, setBubbleAnchor] = useState<{ top: number; left: number } | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  const iconRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => {
    if (bubbleTimerRef.current !== null) {
      window.clearTimeout(bubbleTimerRef.current);
    }
  }, []);

  return (
    <div
      className={"rail-wrap" + (active ? " active" : "")}
      onClick={onActivate}
      onMouseEnter={() => {
        if (bubbleTimerRef.current !== null) {
          window.clearTimeout(bubbleTimerRef.current);
        }
        bubbleTimerRef.current = window.setTimeout(() => {
          const rect = iconRef.current?.getBoundingClientRect();
          if (rect !== undefined) {
            setBubbleAnchor({ top: rect.top + rect.height / 2, left: rect.right + 4 });
          }
        }, 400);
      }}
      onMouseLeave={() => {
        if (bubbleTimerRef.current !== null) {
          window.clearTimeout(bubbleTimerRef.current);
          bubbleTimerRef.current = null;
        }
        setBubbleAnchor(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {active ? <span className="rail-pill" /> : null}
      <div ref={iconRef} className={"rail-icon" + (expired ? " expired" : "")}>
        <ServerIconBody iconUrl={iconUrl} name={name} />
      </div>
      {/* A SIBLING of the icon, like the Home badge: inside .rail-icon the
          squircle clip-path would cut it (live report). */}
      {badge !== null ? (
        <span className={"rail-badge" + (badge.mention > 0 ? "" : " plain")}>
          {badge.unread > 99 ? "99+" : badge.unread}
        </span>
      ) : null}
      {bubbleAnchor !== null
        ? createPortal(
          <span className="rail-name-bubble" style={{ top: bubbleAnchor.top, left: bubbleAnchor.left }}>
            {name}
          </span>,
          document.body,
        )
        : null}
    </div>
  );
}

/**
 * oak's ServerNode unread badge: grey = unread server-channel messages, red =
 * mentioned; shown on EVERY server (the active one included). The ACTIVE
 * instance counts live from its read-state store (DM channels excluded — those
 * feed the Home badge); inactive instances read the snapshot totals, refreshed
 * on switch and on entering the DM view.
 */
function useServerBadge(recordId: string, session: ConnectionSession | null): { unread: number; mention: number } | null {
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const active = session !== null && session.recordId === recordId;
  // Both hooks run unconditionally (hook rules); the active flag picks the winner.
  const liveStates = useStore(active && session !== null ? session.readStateStore : nullReadStateStore, (states) => states);
  const liveDms = useStore(active && session !== null ? session.socialStore : nullSocialStore, (state) => state.dms);
  const background = useStore(socialDirectory, (snapshots) => snapshots);
  if (!badgeEnabled) {
    return null;
  }
  if (active) {
    const dmIds = new Set(liveDms.map((dm) => dm.id));
    let unread = 0;
    let mention = 0;
    for (const [channelId, state] of liveStates) {
      if (!dmIds.has(channelId)) {
        unread += state.unreadCount;
        mention += state.mentionCount;
      }
    }
    return unread > 0 ? { unread, mention } : null;
  }
  const snapshot = background.find((entry) => entry.recordId === recordId) ?? null;
  return snapshot !== null && snapshot.serverCounts.unread > 0 ? snapshot.serverCounts : null;
}

/** Home button + the DM-unread badge (mounted only while a session is live).
 *  The badge counts the ACTIVE instance's DMs plus every background snapshot's
 *  seeded counts, PLUS the incoming friend requests across instances (user
 *  decision), and hides while the DM view is open (oak's HomeNode). */
function HomeRailButton({ session }: { session: ConnectionSession }): React.JSX.Element {
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const dms = useStore(session.socialStore, (state) => state.dms);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const readStates = useStore(session.readStateStore, (states) => states);
  const background = useStore(socialDirectory, (snapshots) => snapshots);
  // Live badge toggle (oak's onApplied badge rebuild) — see Sidebar.
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const activeUnread = dms.reduce(
    (total, dm) => total + (readStates.get(dm.id)?.unreadCount ?? 0),
    0,
  );
  const backgroundUnread = background.reduce(
    (total, snapshot) => total + [...snapshot.dmCounts.values()].reduce((sum, counts) => sum + counts.unread, 0),
    0,
  );
  const pendingTotal = relationships.filter((entry) => entry.type === "PENDING_INCOMING").length
    + background.reduce(
      (total, snapshot) => total + snapshot.relationships.filter((entry) => entry.type === "PENDING_INCOMING").length,
      0,
    );
  const dmUnread = activeUnread + backgroundUnread + pendingTotal;
  return (
    <div className={"rail-wrap home" + (dmMode ? " active" : "")} onClick={toggleHomeMode}>
      {dmMode ? <span className="rail-pill" /> : null}
      <div className="rail-icon home"><span className="icon mdi-home" /></div>
      {!dmMode && badgeEnabled && dmUnread > 0 ? (
        <span className="rail-badge">{dmUnread > 99 ? "99+" : dmUnread}</span>
      ) : null}
    </div>
  );
}
