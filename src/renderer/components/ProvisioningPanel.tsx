import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_ACCOUNT_LOGIN,
  DEFAULT_ACCOUNT_PASSWORD,
  validateProvisioningParams,
  type ProvisioningParams,
} from "../../domain/provisioning/params";
import type { ProvisioningIpcEvent } from "../bridges";
import { PasswordInput } from "./PasswordInput";
import { startSession } from "../runtime";

/**
 * The Create tab of the Add-a-server dialog (round C): a fresh Ubuntu server
 * becomes a running OAK deployment over SSH — Docker, the compose stack,
 * per-deployment secrets, TLS and the OWNER account — then the client logs
 * into it automatically. The SSH credentials exist only inside this run; the
 * admin password is used for the automatic login and then lives on as the
 * account's password (the user can change it in Settings → Account).
 */

const STAGE_ORDER = [
  "download",
  "connect",
  "probe",
  "docker",
  "layout",
  "upload",
  "env",
  "certificate",
  "firewall",
  "compose",
  "wait",
  "register",
] as const;

type StageId = (typeof STAGE_ORDER)[number];

const STAGE_LABELS: Record<StageId, string> = {
  download: "Server jar",
  connect: "SSH connection",
  probe: "Server check",
  docker: "Docker",
  layout: "Deployment directory",
  upload: "Upload files",
  env: "Secrets",
  certificate: "TLS certificate",
  firewall: "Firewall",
  compose: "Start the stack",
  wait: "Wait for the server",
  register: "Owner account",
};

interface StepState {
  state: "start" | "done" | "log" | "failed";
  detail?: string;
}

export function ProvisioningPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }): React.JSX.Element {
  // ── the form ────────────────────────────────────────────────────────────
  const [host, setHost] = useState("");
  const [sshLogin, setSshLogin] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [accountLogin, setAccountLogin] = useState("");
  const [accountNickname, setAccountNickname] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [domain, setDomain] = useState("");
  const [firewall, setFirewall] = useState(true);
  const [jarPath, setJarPath] = useState("");

  // ── the run ─────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<"form" | "running" | "loggingIn" | "needsLogin" | "failed">("form");
  const [steps, setSteps] = useState<Partial<Record<StageId, StepState>>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The admin password outlives the form fields (they unmount on success). */
  const adminPasswordRef = useRef("");

  // Report the in-flight state upward: the login tabs lock for the run's
  // duration (walking away from the panel must stay impossible).
  useEffect(() => {
    onBusyChange?.(phase === "running" || phase === "loggingIn");
    return () => onBusyChange?.(false);
  }, [phase, onBusyChange]);

  useEffect(() => {
    window.spaceProvisioning?.onEvent((event: ProvisioningIpcEvent) => {
      if (event.kind === "step") {
        const stage = event.stage as StageId;
        setSteps((previous) => ({
          ...previous,
          [stage]: { state: event.state, detail: event.detail },
        }));
        if (event.detail !== undefined) {
          setLogLines((previous) => [...previous, `${STAGE_LABELS[stage] ?? stage}: ${event.detail}`]);
        } else if (event.state === "start") {
          setLogLines((previous) => [...previous, `${STAGE_LABELS[stage] ?? stage}…`]);
        }
        if (event.state === "failed") {
          setPhase("failed");
        }
      } else if (event.kind === "failed") {
        setError(`${event.message}`);
        setPhase("failed");
      } else {
        // succeeded: log in automatically when the typed password fits the
        // account (a fresh registration, or an adopt re-run that logged in).
        if (event.outcome.ownerReady) {
          setPhase("loggingIn");
          void startSession(event.outcome.hostUrl, "login", event.outcome.adminUsername, adminPasswordRef.current);
        } else {
          setPhase("needsLogin");
        }
      }
    });
  }, []);

  const submit = (): void => {
    // The Space account falls back to the admin/admin/password defaults for
    // empty fields (user decision) — the one-password setup path.
    const effectiveAdminLogin = accountLogin.trim().length > 0 ? accountLogin.trim() : DEFAULT_ACCOUNT_LOGIN;
    const effectiveAdminNickname = accountNickname.trim().length > 0 ? accountNickname.trim() : null;
    const effectiveAdminPassword = accountPassword.length > 0 ? accountPassword : DEFAULT_ACCOUNT_PASSWORD;
    const params: ProvisioningParams = {
      host,
      sshPort: Number(sshPort),
      sshLogin,
      sshPassword: sshPassword.length > 0 ? sshPassword : null,
      sshKeyPath: sshKeyPath.trim().length > 0 ? sshKeyPath.trim() : null,
      domain: domain.trim().length > 0 ? domain.trim() : null,
      firewall,
      adminLogin: effectiveAdminLogin,
      adminNickname: effectiveAdminNickname,
      adminPassword: effectiveAdminPassword,
      jarPath: jarPath.trim().length > 0 ? jarPath.trim() : null,
    };
    const validation = validateProvisioningParams(params);
    if (validation !== null) {
      setError(validation);
      return;
    }
    if (window.spaceProvisioning === undefined) {
      setError("Provisioning is not available in this build.");
      return;
    }
    adminPasswordRef.current = effectiveAdminPassword;
    setError(null);
    setSteps({});
    setLogLines([]);
    setPhase("running");
    void window.spaceProvisioning.start(params);
  };

  if (phase === "running" || phase === "loggingIn" || phase === "needsLogin") {
    return (
      <div className="prov-progress">
        <div className="prov-steps">
          {STAGE_ORDER.filter((stage) => stage !== "firewall" || firewall).map((stage) => {
            const step = steps[stage];
            const status = step?.state === "done"
              ? "done"
              : step?.state === "failed"
                ? "failed"
                : step !== undefined
                  ? "running"
                  : "pending";
            return (
              <div key={stage} className={`prov-step prov-step-${status}`}>
                <span className={`prov-step-icon ${status === "running" ? "icon mdi-refresh sp-spin" : "icon"}`}>
                  {status === "done" ? "✓" : status === "failed" ? "✕" : status === "pending" ? "○" : ""}
                </span>
                <span className="prov-step-label">{STAGE_LABELS[stage]}</span>
                {step?.detail !== undefined && status !== "pending"
                  ? <span className="prov-step-detail">{step.detail}</span>
                  : null}
              </div>
            );
          })}
        </div>
        {phase === "running" ? (
          <>
            <div className="settings-hint">
              The first build downloads base images and can take several minutes — keep this window open.
            </div>
            <details className="prov-log">
              <summary>Details</summary>
              <div className="prov-log-lines">{logLines.join("\n")}</div>
            </details>
            <div className="modal-actions">
              <button className="ghost" onClick={() => void window.spaceProvisioning?.cancel()}>Cancel</button>
            </div>
          </>
        ) : phase === "loggingIn" ? (
          <div className="settings-hint">The server is ready — logging in as the owner…</div>
        ) : (
          <>
            <div className="settings-hint">
              The server is ready, but its admin account already exists with a different
              password — open the Log in tab and use that password.
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setPhase("form")}>Back</button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="prov-form">
      <div className="settings-hint">
        Set up a brand-new OAK server on a Linux machine over SSH: the client installs
        Docker, deploys the whole stack with fresh secrets and its own TLS certificate,
        creates the owner account and logs you in.
      </div>
      <label className="settings-field">
        <span>Server address (IP or host name)</span>
        <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="203.0.113.10" autoFocus />
      </label>
      <label className="settings-field">
        <span>SSH user</span>
        <input type="text" value={sshLogin} onChange={(event) => setSshLogin(event.target.value)} placeholder="root" autoComplete="off" />
      </label>
      <label className="settings-field">
        <span>SSH password</span>
        <PasswordInput value={sshPassword} onChange={setSshPassword} placeholder="The server account's password" autoComplete="off" />
      </label>
      <label className="settings-field">
        <span>Space account login</span>
        <input
          type="text"
          value={accountLogin}
          onChange={(event) => setAccountLogin(event.target.value)}
          placeholder={DEFAULT_ACCOUNT_LOGIN}
          autoComplete="off"
        />
      </label>
      <label className="settings-field">
        <span>Space account nickname</span>
        <input
          type="text"
          value={accountNickname}
          onChange={(event) => setAccountNickname(event.target.value)}
          placeholder={DEFAULT_ACCOUNT_LOGIN}
          autoComplete="off"
        />
      </label>
      <label className="settings-field">
        <span>Space account password</span>
        <PasswordInput
          value={accountPassword}
          onChange={setAccountPassword}
          onEnter={submit}
          placeholder={DEFAULT_ACCOUNT_PASSWORD}
          autoComplete="new-password"
        />
      </label>
      <div className="settings-hint">
        Empty Space account fields default to {DEFAULT_ACCOUNT_LOGIN} / {DEFAULT_ACCOUNT_LOGIN} /
        {DEFAULT_ACCOUNT_PASSWORD} — change the password after the first login if the server is
        reachable from the internet.
      </div>
      <details className="prov-advanced">
        <summary>Advanced</summary>
        <label className="settings-field">
          <span>SSH port</span>
          <input type="text" value={sshPort} onChange={(event) => setSshPort(event.target.value)} placeholder="22" />
        </label>
        <label className="settings-field">
          <span>Private key file (instead of the password)</span>
          <input type="text" value={sshKeyPath} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
        </label>
        <label className="settings-field">
          <span>Domain (optional — a Let's Encrypt certificate instead of a pinned self-signed one)</span>
          <input type="text" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="oak.example.com" />
        </label>
        <label className="settings-field prov-check">
          <input type="checkbox" checked={firewall} onChange={(event) => setFirewall(event.target.checked)} />
          <span>Configure the firewall (ufw): SSH, HTTPS, TURN and voice media only</span>
        </label>
        <label className="settings-field">
          <span>Server jar override (empty = the jar bundled with this client)</span>
          <input type="text" value={jarPath} onChange={(event) => setJarPath(event.target.value)} placeholder="C:\Users\you\Downloads\oak-server.jar" />
        </label>
      </details>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="primary" onClick={submit}>Set up a server…</button>
      </div>
    </div>
  );
}
