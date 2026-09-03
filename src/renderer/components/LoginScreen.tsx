import { useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, startSession } from "../runtime";
import { DEFAULT_REST_BASE_URL } from "../../config";

export function LoginScreen(): React.JSX.Element {
  const error = useStore(appStore, (state) => state.loginError);
  const busy = useStore(appStore, (state) => state.loginBusy);
  const [serverUrl, setServerUrl] = useState(DEFAULT_REST_BASE_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (mode: "login" | "register") => {
    void startSession(serverUrl.trim().replace(/\/+$/, ""), mode, username.trim(), password);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-title">space</div>
        <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://localhost:8080" />
        <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" autoComplete="username" />
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
        <div className="error-line">{error ?? ""}</div>
        <button className="primary" disabled={busy} onClick={() => submit("login")}>
          {busy ? "Connecting…" : "Log in"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => submit("register")}>
          Register
        </button>
      </div>
    </div>
  );
}
