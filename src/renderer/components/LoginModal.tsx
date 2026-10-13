import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, closeLoginForm, startSession } from "../runtime";
import { DEFAULT_REST_BASE_URL } from "../../config";
import { isValidHostUrl, normalizeHostUrl } from "../../domain/session/connection-record";
import { parseInviteLink } from "../../domain/logic/invite-link";
import { Modal } from "./Modal";
import { PasswordInput } from "./PasswordInput";
import { ProvisioningPanel } from "./ProvisioningPanel";

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

  const submitLogin = () => {
    const attempt = () => {
      const normalized = normalizeHostUrl(serverUrl);
      if (!isValidHostUrl(normalized)) {
        appStore.patch({ loginError: "Server address must start with http:// or https://." });
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
            ? "Paste an invite link to register."
            : "That invite link does not look valid.",
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
    <Modal title="Add a server" onClose={closeLoginForm}>
      <div className="settings-tabs login-tabs">
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "create" ? " active" : "")} onClick={() => setTab("create")}>Create</button>
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "login" ? " active" : "")} onClick={() => setTab("login")}>Log in</button>
        <button disabled={provisionBusy} className={"settings-tab" + (tab === "register" ? " active" : "")} onClick={() => setTab("register")}>Register</button>
      </div>
      {/* The Create panel stays MOUNTED (hidden, not unmounted) while other
          tabs are open: an in-flight run keeps its step screen and listeners
          even if the user somehow walks away. */}
      <div style={{ display: tab === "create" ? "" : "none" }}>
        <ProvisioningPanel onBusyChange={setProvisionBusy} />
      </div>
      {tab === "login" ? (
        <>
          <label className="settings-field">
            <span>Server address</span>
            <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://server.host (localhost defaults to http)" autoFocus />
          </label>
          <label className="settings-field">
            <span>Username</span>
            <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" autoComplete="username" />
          </label>
          <label className="settings-field">
            <span>Password</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              onEnter={submitLogin}
              placeholder="Password (8+ chars)"
              autoComplete="current-password"
            />
          </label>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions">
            <button className="ghost" disabled={busy} onClick={closeLoginForm}>Cancel</button>
            <button className="primary" disabled={busy} onClick={submitLogin}>
              {busy ? "Connecting…" : "Log in"}
            </button>
          </div>
        </>
      ) : tab === "register" ? (
        <>
          <label className="settings-field">
            <span>Invite link</span>
            <input type="text" value={inviteLink} onChange={(event) => setInviteLink(event.target.value)} placeholder="https://server.host/#invite=…" autoFocus />
          </label>
          {parsedInviteLink !== null ? (
            // The address rides the link — confirm where the registration goes, no separate field.
            <div className="settings-hint">Server: {parsedInviteLink.origin}</div>
          ) : null}
          <label className="settings-field">
            <span>Nickname</span>
            <input type="text" value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder="Same as username if empty" />
          </label>
          <label className="settings-field">
            <span>Username</span>
            <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" autoComplete="username" />
          </label>
          <label className="settings-field">
            <span>Password</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              onEnter={submitRegister}
              placeholder="Password (8+ chars)"
              autoComplete="new-password"
            />
          </label>
          <div className="settings-hint">Ask a member with the "Manage Members" permission for an invite link.</div>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions">
            <button className="ghost" disabled={busy} onClick={closeLoginForm}>Cancel</button>
            <button className="primary" disabled={busy} onClick={submitRegister}>
              {busy ? "Connecting…" : "Register"}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
