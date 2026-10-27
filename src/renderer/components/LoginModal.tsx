import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, closeLoginForm, startSession } from "../runtime";
import { DEFAULT_REST_BASE_URL } from "../../config";
import { isValidHostUrl, normalizeHostUrl } from "../../domain/session/connection-record";
import { parseInviteLink } from "../../domain/logic/invite-link";
import { Modal } from "./Modal";
import { PasswordInput } from "./PasswordInput";
import { ProvisioningPanel } from "./ProvisioningPanel";
import { useT } from "../hooks/useT";

/**
 * The add-server dialog as a MODAL over the always-present main window (oak's Add
 * Server dialog): opened by the rail "+", an expired session or a kick. Three tabs
 * (the Server Settings → Roles underline idiom): Create (provisioning — the client
 * deploys a brand-new OAK server over SSH and logs in as its OWNER account),
 * Log in (the classic address/username/password form) and Register — invite-link
 * registration on an existing server ONLY: the link is required and its origin is
 * the address (no separate address field).
 *
 * A bare host in the address auto-gains a scheme (localhost → http, anything else →
 * https — the deployed-server default since the TLS entry point). When the server's
 * certificate fails validation (self-signed deployment), main surfaces the
 * fingerprint and the App-level TlsTrustModal renders the trust decision; its Trust
 * button re-runs the attempt registered here via `tlsRetry`.
 */
export function LoginModal(): React.JSX.Element {
  const t = useT();
  const error = useStore(appStore, (state) => state.loginError);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const prefill = useStore(appStore, (state) => state.loginPrefill);
  const [tab, setTab] = useState<"create" | "login" | "register">("login");
  const [serverUrl, setServerUrl] = useState(prefill?.url ?? DEFAULT_REST_BASE_URL);
  const [username, setUsername] = useState(prefill?.username ?? "");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  /** True while a provisioning run is in flight (the Create panel reports
   *  it): the tabs lock — a stray click must not walk away from the run
   *  (live report 2026-10-12: the switch unmounted the panel mid-install). */
  const [provisionBusy, setProvisionBusy] = useState(false);
  /** The strict run signal: while the SSH pipeline is live, the WHOLE dialog
   *  locks (backdrop clicks, Escape and the close button do nothing — live
   *  report 2026-10-13: a stray backdrop click hid the install screen). */
  const [provisionRunning, setProvisionRunning] = useState(false);

  const submitLogin = () => {
    const attempt = () => {
      const normalized = normalizeHostUrl(serverUrl);
      if (!isValidHostUrl(normalized)) {
        appStore.patch({ loginError: t("login.errAddress") });
        return;
      }
      void startSession(normalized, "login", username.trim(), password);
    };
    appStore.patch({ tlsRetry: attempt });
    attempt();
  };

  // Register: the link is REQUIRED — its origin IS the server address, its hash carries
  // the single-use secret. There is no first-member bootstrap here: the OWNER account of
  // a new server will be created automatically by the (future) provisioning flow.
  const parsedInviteLink = parseInviteLink(inviteLink);

  const submitRegister = () => {
    const attempt = () => {
      if (parsedInviteLink === null) {
        appStore.patch({
          loginError: inviteLink.trim().length === 0
            ? t("login.errInviteEmpty")
            : t("login.errInviteInvalid"),
        });
        return;
      }
      void startSession(parsedInviteLink.origin, "register", username.trim(), password, {
        nickname: nickname.trim().length > 0 ? nickname.trim() : undefined,
        inviteSecret: parsedInviteLink.secret,
      });
    };
    appStore.patch({ tlsRetry: attempt });
    attempt();
  };

  return (
    <Modal title={t("rail.addServer")} onClose={closeLoginForm} locked={provisionRunning}>
      <div className="settings-tabs login-tabs">
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "create" ? " active" : "")} onClick={() => setTab("create")}>{t("login.tab.create")}</button>
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "login" ? " active" : "")} onClick={() => setTab("login")}>{t("login.tab.login")}</button>
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "register" ? " active" : "")} onClick={() => setTab("register")}>{t("login.tab.register")}</button>
      </div>
      {/* The Create panel stays MOUNTED (hidden, not unmounted) while other
          tabs are open: an in-flight run keeps its step screen and listeners
          even if the user somehow walks away. */}
      <div style={{ display: tab === "create" ? "" : "none" }}>
        <ProvisioningPanel onBusyChange={setProvisionBusy} onRunningChange={setProvisionRunning} />
      </div>
      {tab === "login" ? (
        <>
          <label className="settings-field">
            <span>{t("login.serverAddress")}</span>
            <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder={t("login.addressPlaceholder")} autoFocus />
          </label>
          <label className="settings-field">
            <span>{t("login.username")}</span>
            <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("login.username")} autoComplete="username" />
          </label>
          <label className="settings-field">
            <span>{t("login.password")}</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              onEnter={submitLogin}
              placeholder={t("login.passwordPlaceholder")}
              autoComplete="current-password"
            />
          </label>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions">
            <button className="ghost" disabled={busy} onClick={closeLoginForm}>{t("common.cancel")}</button>
            <button className="primary" disabled={busy} onClick={submitLogin}>
              {busy ? t("login.connecting") : t("serverMenu.logIn")}
            </button>
          </div>
        </>
      ) : tab === "register" ? (
        <>
          <label className="settings-field">
            <span>{t("login.inviteLink")}</span>
            <input type="text" value={inviteLink} onChange={(event) => setInviteLink(event.target.value)} placeholder="https://server.host/#invite=…" autoFocus />
          </label>
          {parsedInviteLink !== null ? (
            // The address rides the link — confirm where the registration goes, no separate field.
            <div className="settings-hint">{t("login.serverOrigin", { origin: parsedInviteLink.origin })}</div>
          ) : null}
          <label className="settings-field">
            <span>{t("settings.nicknameHeader")}</span>
            <input type="text" value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder={t("login.nicknamePlaceholder")} />
          </label>
          <label className="settings-field">
            <span>{t("login.username")}</span>
            <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("login.username")} autoComplete="username" />
          </label>
          <label className="settings-field">
            <span>{t("login.password")}</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              onEnter={submitRegister}
              placeholder={t("login.passwordPlaceholder")}
              autoComplete="new-password"
            />
          </label>
          <div className="settings-hint">{t("login.inviteHint")}</div>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions">
            <button className="ghost" disabled={busy} onClick={closeLoginForm}>{t("common.cancel")}</button>
            <button className="primary" disabled={busy} onClick={submitRegister}>
              {busy ? t("login.connecting") : t("login.registerVerb")}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
