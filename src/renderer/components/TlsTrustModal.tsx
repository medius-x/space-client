import { useStore } from "../hooks/useStore";
import { useT } from "../hooks/useT";
import { appStore, decideTlsCertificate } from "../runtime";
import { Modal } from "./Modal";

/**
 * The certificate-fingerprint confirmation for a server whose certificate
 * could not be verified (a self-signed deployment behind the TLS entry point).
 * The wording stays calm by design (user decision 2026-10-08 — "Untrusted
 * server certificate" read as an accusation): the dialog simply SHOWS the
 * fingerprint — a self-hosted server's owner can confirm it, everyone else
 * connects the way every self-hosted tool does — and Connect pins it to the
 * server record. Rendered at App level on purpose: the prompt can arrive for
 * a BACKGROUND session with the login form closed.
 */
export function TlsTrustModal(): React.JSX.Element {
  const t = useT();
  const tlsPrompt = useStore(appStore, (state) => state.tlsPrompt);
  const tlsRetry = useStore(appStore, (state) => state.tlsRetry);
  if (tlsPrompt === null) {
    return <></>;
  }
  return (
    <Modal
      title={tlsPrompt.changedPinned ? t("tls.changedTitle") : t("tls.fingerprintTitle")}
      onClose={() => void decideTlsCertificate(tlsPrompt, false)}
      elevated
    >
      <div className="modal-note">
        {tlsPrompt.changedPinned
          ? t("tls.changedNote", { host: tlsPrompt.hostname })
          : t("tls.selfSignedNote", { host: tlsPrompt.hostname })}
      </div>
      <label className="settings-field">
        <span>{t("tls.fingerprintLabel")}</span>
        <input
          type="text"
          readOnly
          value={tlsPrompt.displayFingerprint}
          className="tls-fingerprint"
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="modal-actions">
        <button className="ghost" onClick={() => void decideTlsCertificate(tlsPrompt, false)}>{t("common.cancel")}</button>
        <button
          className="primary"
          onClick={() => {
            void decideTlsCertificate(tlsPrompt, true).then(() => {
              appStore.getSnapshot().tlsRetry?.();
            });
          }}
        >
          {t("tls.connect")}
        </button>
      </div>
    </Modal>
  );
}
