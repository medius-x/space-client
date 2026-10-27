import { useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  canManageServerSettingsOfRecord,
  closeServerMenu,
  connectionDirectory,
  openAccountSettings,
  openServerSettings,
  recordServerOnline,
  reloginConnection,
  removeConnection,
  sessionBinding,
  sessionsIndex,
  switchAndOpenAccountSettings,
  switchAndOpenServerSettings,
} from "../runtime";
import type { ConnectionRecord } from "../../domain/session/connection-record";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { PasswordInput } from "./PasswordInput";
import { useT } from "../hooks/useT";

/**
 * The server dropdown, lifted out of the Sidebar (2026-09-24) so BOTH triggers
 * open the SAME menu: the Sidebar's server-name header and a right-click on a
 * rail avatar (the pre-2026-09-21 rail affordance, restored by user request —
 * the click path stays too). The recordId targets the ROW: on a NON-active
 * record the settings entries SWITCH to it first and then open (user request
 * 2026-09-24); Re-login and Delete work for any saved record directly.
 */
export function ServerMenu(): React.JSX.Element {
  const t = useT();
  const session = useStore(sessionBinding, (current) => current);
  const menu = useStore(appStore, (state) => state.serverMenu);
  // Re-evaluate the online gate on every STOMP flip of the ACTIVE record
  // (appStore.stompState) and on background sessions appearing/disappearing
  // (sessionsIndex); a background record's own reconnect flips are covered by
  // the switch-and-open gate anyway.
  useStore(appStore, (state) => state.stompState);
  useStore(sessionsIndex, (version) => version);
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
          label: t("serverMenu.serverSettings"),
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
    // Offline the account forms (password/login/avatar) can only fail on save —
    // the entry hides against a dead server (user request 2026-10-15), leaving
    // Re-login as the honest way back in. The separator rides INSIDE this group
    // so a hidden entry never leaves a leading/double rule.
    ...(recordServerOnline(menu.recordId)
      ? [
        {
          label: t("serverMenu.accountSettings"),
          action: () => {
            if (isActiveRecord) {
              openAccountSettings();
            } else {
              void switchAndOpenAccountSettings(menu.recordId);
            }
          },
        },
        { label: "", separator: true, action: () => undefined },
      ]
      : []),
    { label: t("serverMenu.relogin"), action: () => {
      if (record !== null) {
        setReloginTarget(record);
      }
    } },
    { label: t("common.delete"), danger: true, action: () => {
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
        <ContextMenu x={menu.x} y={menu.y} items={items} anchor={menu.anchor} onClose={() => closeServerMenu()} />
      ) : null}
      {reloginTarget !== null ? (
        <ReloginModal record={reloginTarget} onClose={() => setReloginTarget(null)} />
      ) : null}
      {deleteTarget !== null ? (
        <Modal title={t("serverMenu.deleteTitle")} onClose={() => setDeleteTarget(null)}>
          {/* oak's ConfirmDialog wording verbatim. */}
          <div className="modal-note">
            {t("serverMenu.deleteNote", { server: deleteTarget.cachedServerName ?? deleteTarget.hostUrl })}
          </div>
          <div className="modal-actions left">
            <button className="ghost" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</button>
            <button className="danger" onClick={() => {
              void removeConnection(deleteTarget.id);
              setDeleteTarget(null);
            }}>{t("common.delete")}</button>
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
  const t = useT();
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
    <Modal title={t("serverMenu.relogin")} onClose={onClose}>
      <div className="modal-note">{t("serverMenu.reloginNote", { user: record.username, server: serverName })}</div>
      <PasswordInput
        autoFocus
        value={password}
        onChange={setPassword}
        onEnter={() => void submit()}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions left">
        <button className="ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary" disabled={busy || password.length === 0} onClick={() => void submit()}>{t("serverMenu.logIn")}</button>
      </div>
    </Modal>
  );
}
