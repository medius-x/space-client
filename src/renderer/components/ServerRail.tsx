import { useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  beginAddServer,
  connectionDirectory,
  removeConnection,
  switchConnection,
} from "../runtime";
import { EXPIRED_MARKER } from "../../domain/session/connection-record";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/**
 * The Discord-style server rail: one icon per saved connection, click to switch,
 * right-click to forget. The "+" opens the login form (the live session keeps
 * running until a new login replaces it).
 */
export function ServerRail({ activeRecordId }: { activeRecordId: string | null }): React.JSX.Element {
  const records = useStore(connectionDirectory, (records) => records);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const [menu, setMenu] = useState<{ recordId: string; x: number; y: number } | null>(null);

  const menuItems: ContextMenuItem[] = menu === null ? [] : [
    { label: "Switch here", action: () => void switchConnection(menu.recordId) },
    { label: "Forget this server", danger: true, action: () => void removeConnection(menu.recordId) },
  ];

  return (
    <nav className="server-rail">
      {records.map((record) => (
        <div
          key={record.id}
          className={"rail-icon"
            + (record.id === activeRecordId ? " active" : "")
            + (record.token === EXPIRED_MARKER ? " expired" : "")}
          title={`${record.cachedServerName ?? record.hostUrl} · ${record.username}`}
          onClick={() => {
            if (record.id !== activeRecordId && !busy) {
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
