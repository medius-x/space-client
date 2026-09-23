import { useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  canManageServerSettingsOfRecord,
  closeServerMenu,
  connectionDirectory,
  openAccountSettings,
  openServerSettings,
  reloginConnection,
  removeConnection,
  sessionBinding,
  switchAndOpenAccountSettings,
  switchAndOpenServerSettings,
} from "../runtime";
import type { ConnectionRecord } from "../../domain/session/connection-record";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";

/**
 * The server dropdown, lifted out of the Sidebar (2026-09-24) so BOTH triggers
 * open the SAME menu: the Sidebar's server-name header and a right-click on a
 * rail avatar (the pre-2026-09-21 rail affordance, restored by user request —
 * the click path stays too). The recordId targets the ROW: on a NON-active
 * record the settings entries SWITCH to it first and then open (user request
 * 2026-09-24); Re-login and Delete work for any saved record directly.
 */
export function ServerMenu(): React.JSX.Element {
  const session = useStore(sessionBinding, (current) => current);
  const menu = useStore(appStore, (state) => state.serverMenu);
  const [reloginTarget, setReloginTarget] = useState<ConnectionRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRecord | null>(null);
  const record = menu !== null ? connectionDirectory.get(menu.recordId) ?? null : null;
  const isActiveRecord = menu !== null && session !== null && session.recordId === menu.recordId;
  const items: ContextMenuItem[] = menu === null ? [] : [
    // Gated live (the record's OWN session — active or background): without any
    // settings permission the entry never appears (oak parity). A NON-active
    // record's entry switches to it first, then opens (user request 2026-09-24).
    ...(canManageServerSettingsOfRecord(menu.recordId)
      ? [
        {
          label: "Server Settings",
          action: () => {
            if (isActiveRecord) {
              openServerSettings();
            } else {
              void switchAndOpenServerSettings(menu.recordId);
            }
          },
        },
        { label: "", separator: true, action: () => undefined },
      ]
      : []),
    {
      label: "Account settings",
      action: () => {
        if (isActiveRecord) {
          openAccountSettings();
        } else {
          void switchAndOpenAccountSettings(menu.recordId);
        }
      },
    },
    { label: "", separator: true, action: () => undefined },
    { label: "Re-login", action: () => {
      if (record !== null) {
        setReloginTarget(record);
      }
    } },
    { label: "Delete", danger: true, action: () => {
      if (record !== null) {
        setDeleteTarget(record);
      }
    } },
  ];
  // The modals render OUTSIDE the menu gate: the ContextMenu closes itself
  // BEFORE running an item's action, and the dialogs must outlive that close.
  return (
    <>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => closeServerMenu()} />
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
    </>
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
