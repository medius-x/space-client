import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, closeLoginForm, startSession } from "../runtime";
import { DEFAULT_REST_BASE_URL } from "../../config";
import { Modal } from "./Modal";

/**
 * The login form as a MODAL over the always-present main window (oak's Add
 * Server dialog): opened by the rail "+", an expired session or a kick. ✕
 * just closes it — the window itself never becomes a login screen.
 */
export function LoginModal(): React.JSX.Element {
  const error = useStore(appStore, (state) => state.loginError);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const prefill = useStore(appStore, (state) => state.loginPrefill);
  const [serverUrl, setServerUrl] = useState(prefill?.url ?? DEFAULT_REST_BASE_URL);
  const [username, setUsername] = useState(prefill?.username ?? "");
  const [password, setPassword] = useState("");

  const submit = (mode: "login" | "register") => {
    void startSession(serverUrl.trim().replace(/\/+$/, ""), mode, username.trim(), password);
  };

  return (
    <Modal title="Add a server" onClose={closeLoginForm}>
      <label className="settings-field">
        <span>Server address</span>
        <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://localhost:8080" autoFocus />
      </label>
      <label className="settings-field">
        <span>Username</span>
        <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" autoComplete="username" />
      </label>
      <label className="settings-field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit("login");
            }
          }}
          placeholder="Password (8+ chars)"
          autoComplete="current-password"
        />
      </label>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" disabled={busy} onClick={closeLoginForm}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => submit("login")}>
          {busy ? "Connecting…" : "Log in"}
        </button>
      </div>
      <div className="settings-hint">No account on that server yet? Register with the same form.</div>
      <div className="modal-actions">
        <button className="ghost" disabled={busy} onClick={() => submit("register")}>Register</button>
      </div>
    </Modal>
  );
}
