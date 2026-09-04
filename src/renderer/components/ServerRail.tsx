import { useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  beginAddServer,
  canManageServerSettings,
  connectionDirectory,
  exitHomeMode,
  openServerSettings,
  removeConnection,
  switchConnection,
  toggleHomeMode,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { EXPIRED_MARKER } from "../../domain/session/connection-record";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/**
 * The Discord-style server rail: the Home button (friends + DMs) on top, then one
 * icon per saved connection — click to switch, right-click to forget. The "+" opens
 * the login form (the live session keeps running until a new login replaces it).
 */
export function ServerRail({ activeRecordId, session }: {
  activeRecordId: string | null;
  session: ConnectionSession | null;
}): React.JSX.Element {
  const records = useStore(connectionDirectory, (records) => records);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const [menu, setMenu] = useState<{ recordId: string; x: number; y: number } | null>(null);

  const menuItems: ContextMenuItem[] = menu === null ? [] : [
    // Gated live: without any settings permission the entry never appears (oak parity).
    ...(menu.recordId === session?.recordId && canManageServerSettings(session)
      ? [{ label: "Server Settings", action: () => openServerSettings() }]
      : []),
    { label: "Switch here", action: () => void switchConnection(menu.recordId) },
    { label: "Forget this server", danger: true, action: () => void removeConnection(menu.recordId) },
  ];

  return (
    <nav className="server-rail">
      {session !== null ? <HomeRailButton session={session} /> : null}
      <div className="rail-separator" />
      {records.map((record) => (
        <div
          key={record.id}
          className={"rail-icon"
            + (record.id === activeRecordId && !dmMode ? " active" : "")
            + (record.token === EXPIRED_MARKER ? " expired" : "")}
          title={`${record.cachedServerName ?? record.hostUrl} · ${record.username}`}
          onClick={() => {
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
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ recordId: record.id, x: event.clientX, y: event.clientY });
          }}
        >
          {(record.cachedServerName ?? record.hostUrl.replace(/^https?:\/\//, "")).charAt(0).toUpperCase() || "?"}
        </div>
      ))}
      <div className="rail-icon add" title="Add a server" onClick={beginAddServer}>+</div>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </nav>
  );
}

/** Home button + the DM-unread badge (mounted only while a session is live). */
function HomeRailButton({ session }: { session: ConnectionSession }): React.JSX.Element {
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const dms = useStore(session.socialStore, (state) => state.dms);
  const readStates = useStore(session.readStateStore, (states) => states);
  const dmUnread = dms.reduce(
    (total, dm) => total + (readStates.get(dm.id)?.unreadCount ?? 0),
    0,
  );
  return (
    <div
      className={"rail-icon home" + (dmMode ? " active" : "")}
      title="Direct messages"
      onClick={toggleHomeMode}
    >
      ⌂
      {dmUnread > 0 ? <span className="rail-badge">{dmUnread > 99 ? "99+" : dmUnread}</span> : null}
    </div>
  );
}
