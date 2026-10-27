import { useStore } from "../hooks/useStore";
import { useT } from "../hooks/useT";
import {
  appStore,
  cancelServerSwitch,
  confirmServerSwitch,
  connectionDirectory,
  sessionBinding,
} from "../runtime";
import { Modal } from "./Modal";

/**
 * The switch-away-from-voice confirmation (user request 2026-10-28): switching
 * the active server ALWAYS leaves the voice room — voice lives on the ACTIVE
 * session only (background sessions hold no voice), so an in-room switch asks
 * first. Mounted at the App level: the dialog must sit above whatever surface
 * the switch was clicked from (the rail, the server menu, the friends pane).
 * Renders nothing without a pending confirmation.
 */
export function SwitchConfirmModal(): React.JSX.Element | null {
  const t = useT();
  const confirm = useStore(appStore, (state) => state.switchConfirm);
  const session = useStore(sessionBinding, (current) => current);
  const voiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  if (confirm === null) {
    return null;
  }
  // The dialog only ever opens with a live in-room session, and the modal
  // blocks the UI while up — the channel cannot change under it, so a one-shot
  // snapshot read is fine (no reactive subscription needed).
  const channelName = session !== null && voiceChannelId !== null
    ? session.channelStore.getSnapshot().find((channel) => channel.id === voiceChannelId)?.name ?? ""
    : "";
  const record = connectionDirectory.get(confirm.recordId);
  const serverName = record?.cachedServerName ?? record?.hostUrl ?? "";
  return (
    <Modal title={t("switchConfirm.title")} onClose={cancelServerSwitch}>
      <div className="modal-note">
        {t("switchConfirm.body", { server: serverName, channel: `#${channelName}` })}
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={cancelServerSwitch}>{t("common.cancel")}</button>
        <button className="primary" onClick={confirmServerSwitch}>{t("switchConfirm.continue")}</button>
      </div>
    </Modal>
  );
}
