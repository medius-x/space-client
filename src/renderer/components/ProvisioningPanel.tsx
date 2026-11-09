import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_ACCOUNT_LOGIN,
  DEFAULT_ACCOUNT_PASSWORD,
  validateProvisioningParams,
  type MigrationTransferParams,
  type ProvisioningParams,
} from "../../domain/provisioning/params";
import { hasServerCapability } from "../../domain/logic/server-capabilities";
import { humanByteSize } from "../../domain/logic/file-size";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { ProvisioningIpcEvent } from "../bridges";
import { downloadMigrationArchive, waitForBuiltBackup } from "../backup-run";
import { releaseBackupScheduleFor, suppressBackupScheduleFor } from "../backup-schedule";
import { PasswordInput } from "./PasswordInput";
import { refreshServerProfilesForHost, startSession } from "../runtime";
import type { MessageKey } from "../../domain/i18n/i18n";
import { useT } from "../hooks/useT";

/**
 * The Create tab of the Add-a-server dialog (round C): a fresh Ubuntu server
 * becomes a running OAK deployment over SSH — Docker, the compose stack,
 * per-deployment secrets, TLS and the OWNER account — then the client logs
 * into it automatically. The SSH credentials exist only inside this run; the
 * admin password is used for the automatic login and then lives on as the
 * account's password (the user can change it in Settings → Account).
 */

const STAGE_ORDER = [
  "backup",
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
  "restore",
  "register",
] as const;

type StageId = (typeof STAGE_ORDER)[number];

/** Stage → dictionary key (compile-checked: every stage has a label entry). */
const STAGE_LABEL_KEYS: Record<StageId, MessageKey> = {
  backup: "provisioning.stage.backup",
  download: "provisioning.stage.download",
  connect: "provisioning.stage.connect",
  probe: "provisioning.stage.probe",
  docker: "provisioning.stage.docker",
  layout: "provisioning.stage.layout",
  upload: "provisioning.stage.upload",
  env: "provisioning.stage.env",
  certificate: "provisioning.stage.certificate",
  firewall: "provisioning.stage.firewall",
  compose: "provisioning.stage.compose",
  wait: "provisioning.stage.wait",
  restore: "provisioning.stage.restore",
  register: "provisioning.stage.register",
};

interface StepState {
  state: "start" | "done" | "log" | "failed";
  detail?: string;
  /** Live progress of the active step (user decision 2026-10-15): after the
   *  step name, before the detail — a byte counter for uploads, the running
   *  command's last output line for docker/compose. */
  progress?: string;
}

export function ProvisioningPanel({ onBusyChange, onRunningChange, mode = "setup", session = null, onDone }: {
  onBusyChange?: (busy: boolean) => void;
  /** The strict "an SSH run is in flight" signal (busy also covers the
   *  automatic login): while true, the surrounding dialog is LOCKED — a stray
   *  backdrop click must not hide the install screen (the run survives in the
   *  main process, but its UI would be gone; live report 2026-10-13). */
  onRunningChange?: (running: boolean) => void;
  /** "migrate" (backup round 2026-10-28): the Migrate dialog's embedding — no
   *  Space-account fields (the accounts come from the archive), the run takes
   *  its own fresh backup AS THE FIRST STEP (user decision, same day: nothing
   *  downloads before the migration actually starts), the button reads Migrate
   *  and the finish hands control back to the embedding dialog. */
  mode?: "setup" | "migrate";
  /** The CURRENT server's session — migrate mode takes its backup through it. */
  session?: ConnectionSession | null;
  /** Migrate mode's finish hook: the needsLogin "back" closes the dialog. */
  onDone?: () => void;
}): React.JSX.Element {
  const t = useT();
  // ── the form ────────────────────────────────────────────────────────────
  const [host, setHost] = useState("");
  const [sshLogin, setSshLogin] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [accountLogin, setAccountLogin] = useState("");
  const [accountNickname, setAccountNickname] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [domain, setDomain] = useState("");
  const [firewall, setFirewall] = useState(true);
  const [jarPath, setJarPath] = useState("");
  /** Restore mode (backup round 2026-10-28): an archive path turns the run
   *  into a restore — no register step, the finish is a manual login. In
   *  migrate mode the field stays hidden: the archive is TAKEN by the run
   *  itself as its first step, and its path never passes through the form. */
  const [backupArchivePath, setBackupArchivePath] = useState("");
  /** Whether the RUNNING/finished run was a restore (drives the step filter
   *  and the finish text — outlives the form fields like the password ref). */
  const restoreArmedRef = useRef(false);
  const [restoredOutcome, setRestoredOutcome] = useState(false);
  /** Migrate mode's backup step (user decision 2026-10-28): the archive is
   *  taken HERE, before the main-process run starts — Cancel during this
   *  window aborts the flow instead of tearing an SSH connection. */
  const backupStepLiveRef = useRef(false);
  const backupCancelledRef = useRef(false);

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

  // The dialog itself locks while the SSH pipeline is live (its Cancel button
  // stays the one explicit exit). NOT locked for the automatic login: that
  // phase has no cancel path, and startSession survives on its own in runtime.
  useEffect(() => {
    onRunningChange?.(phase === "running");
    return () => onRunningChange?.(false);
  }, [phase, onRunningChange]);

  useEffect(() => {
    window.spaceProvisioning?.onEvent((event: ProvisioningIpcEvent) => {
      if (event.kind === "step") {
        const stage = event.stage as StageId;
        setSteps((previous) => ({
          ...previous,
          [stage]: {
            state: event.state,
            // A progress-only event (state "log" without detail) must not wipe
            // the step's standing description.
            detail: event.detail ?? previous[stage]?.detail,
            progress: event.progress,
          },
        }));
        if (event.detail !== undefined) {
          setLogLines((previous) => [...previous, `${t(STAGE_LABEL_KEYS[stage])}: ${event.detail}`]);
        } else if (event.state === "start") {
          setLogLines((previous) => [...previous, `${t(STAGE_LABEL_KEYS[stage])}…`]);
        }
        if (event.state === "failed") {
          setPhase("failed");
        }
      } else if (event.kind === "failed") {
        setError(`${event.message}`);
        setPhase("failed");
        // The migration window is over (the run failed any way) — the old
        // server's backup schedule may fire again.
        if (session !== null) {
          releaseBackupScheduleFor(session.recordId);
        }
      } else {
        // succeeded: log in automatically when the typed password fits the
        // account (a fresh registration, or an adopt re-run that logged in).
        // A RESTORED deployment never auto-logs-in: the accounts came from the
        // archive and the owner's password is the user's alone.
        if (session !== null) {
          releaseBackupScheduleFor(session.recordId);
        }
        setRestoredOutcome(event.outcome.restored);
        // The server may have just been REDEPLOYED under live sessions (the
        // adopt path): repaint their cached profile — the Server Settings
        // version line — without a client restart.
        refreshServerProfilesForHost(event.outcome.hostUrl);
        if (event.outcome.ownerReady) {
          setPhase("loggingIn");
          void startSession(event.outcome.hostUrl, "login", event.outcome.adminUsername, adminPasswordRef.current);
        } else {
          setPhase("needsLogin");
        }
      }
    });
  }, []);

  // Migrate mode: the backup step's download progress rides the single onProgress
  // listener slot while that step is live (the locked dialog owns the slot for the
  // whole run).
  useEffect(() => {
    if (mode !== "migrate") {
      return;
    }
    window.spaceBackup?.onProgress((event) => {
      setSteps((previous) => {
        const step = previous.backup;
        if (step === undefined || step.state === "done" || step.state === "failed") {
          return previous;
        }
        return {
          ...previous,
          backup: {
            ...step,
            progress: event.totalBytes !== null
              ? `${humanByteSize(event.receivedBytes)} / ${humanByteSize(event.totalBytes)}`
              : humanByteSize(event.receivedBytes),
          },
        };
      });
    });
  }, [mode]);

  const submit = (): void => {
    // The Space account falls back to the admin/admin/password defaults for
    // empty fields (user decision) — the one-password setup path.
    const effectiveAdminLogin = accountLogin.trim().length > 0 ? accountLogin.trim() : DEFAULT_ACCOUNT_LOGIN;
    const effectiveAdminNickname = accountNickname.trim().length > 0 ? accountNickname.trim() : null;
    const effectiveAdminPassword = accountPassword.length > 0 ? accountPassword : DEFAULT_ACCOUNT_PASSWORD;
    const baseParams: ProvisioningParams = {
      host,
      sshPort: Number(sshPort),
      sshLogin,
      sshPassword: sshPassword.length > 0 ? sshPassword : null,
      sshKeyPath: sshKeyPath.trim().length > 0 ? sshKeyPath.trim() : null,
      sshKeyPassphrase: sshKeyPassphrase.length > 0 ? sshKeyPassphrase : null,
      domain: domain.trim().length > 0 ? domain.trim() : null,
      firewall,
      adminLogin: effectiveAdminLogin,
      adminNickname: effectiveAdminNickname,
      adminPassword: effectiveAdminPassword,
      jarPath: jarPath.trim().length > 0 ? jarPath.trim() : null,
      backupArchivePath: null,
    };
    const validation = validateProvisioningParams(baseParams);
    if (validation !== null) {
      setError(validation);
      return;
    }
    if (window.spaceProvisioning === undefined) {
      setError(t("provisioning.unavailable"));
      return;
    }
    adminPasswordRef.current = effectiveAdminPassword;
    setError(null);
    setLogLines([]);
    if (mode !== "migrate") {
      const params: ProvisioningParams = {
        ...baseParams,
        backupArchivePath: backupArchivePath.trim().length > 0 ? backupArchivePath.trim() : null,
      };
      restoreArmedRef.current = params.backupArchivePath !== null;
      setSteps({});
      setPhase("running");
      void window.spaceProvisioning.start(params);
      return;
    }
    if (session === null) {
      setError(t("provisioning.unavailable"));
      return;
    }
    // MIGRATE (user decision 2026-10-28): the fresh backup is taken AS THE RUN'S
    // FIRST STEP — nothing downloads before the user actually starts the
    // migration. The archive is one-shot: the main process deletes it when the
    // run ends any way; a CANCEL during this step aborts here, before any SSH.
    restoreArmedRef.current = false;
    backupCancelledRef.current = false;
    backupStepLiveRef.current = true;
    setSteps({ backup: { state: "start" } });
    setPhase("running");
    void runMigrationBackupStep(baseParams, session);
  };

  /** The migrate run's source step (2026-11-02): build the fresh archive, then
   *  deliver it by the LADDER — the direct server-to-server route first (the new
   *  server pulls it from the old one over the one-shot token; this computer
   *  stays out of the byte path), the through-this-computer download as the
   *  always-available fallback (an unreachable old server, a legacy server
   *  without the capability). Cancelled → back to the form, everything cleaned. */
  const runMigrationBackupStep = async (baseParams: ProvisioningParams,
                                        activeSession: ConnectionSession): Promise<void> => {
    suppressBackupScheduleFor(activeSession.recordId);
    let issuedToken: { token: string; archiveSha256: string; archiveBytes: number } | null = null;
    try {
      const built = await waitForBuiltBackup(activeSession, () => backupCancelledRef.current);
      if (backupCancelledRef.current || built.cancelled === true) {
        returnToFormCancelled();
        return;
      }
      if (!built.ok) {
        backupFailed(built.error ?? "backup failed");
        return;
      }
      const digest = built.archiveSha256 ?? null;
      // The direct leg needs the server-side capability; a legacy old server
      // (or a failed issue) routes through this computer without a change.
      if (hasServerCapability(activeSession.serverProfile, "server-migration")) {
        try {
          const issued = await activeSession.rest.issueMigrationTransfer();
          issuedToken = { token: issued.token, archiveSha256: issued.archiveSha256, archiveBytes: issued.archiveBytes };
          const probe = await window.spaceProvisioning?.probeMigration({
            host: baseParams.host,
            sshPort: baseParams.sshPort,
            sshLogin: baseParams.sshLogin,
            sshPassword: baseParams.sshPassword,
            sshKeyPath: baseParams.sshKeyPath,
            sshKeyPassphrase: baseParams.sshKeyPassphrase,
            sourceUrl: activeSession.rest.restOrigin(),
            token: issued.token,
          });
          if (probe !== undefined && probe.direct) {
            const migrationTransfer: MigrationTransferParams = {
              sourceUrl: activeSession.rest.restOrigin(),
              token: issued.token,
              archiveSha256: issued.archiveSha256,
              archiveBytes: issued.archiveBytes,
              certificatePem: probe.certificatePem,
            };
            setSteps((previous) => ({ ...previous, backup: { state: "done" } }));
            restoreArmedRef.current = true;
            void window.spaceProvisioning?.start({ ...baseParams, migrationTransfer });
            return; // the finally below revokes the token only on THIS leg's exit;
            // the run itself revokes nothing — the server's TTL covers a killed client
          }
          setSteps((previous) => ({
            ...previous,
            backup: { state: "log", detail: `${t("provisioning.detail.migrationFallback")}${probe !== undefined ? ` (${probe.reason})` : ""}` },
          }));
        } catch (issueError) {
          setSteps((previous) => ({
            ...previous,
            backup: { state: "log", detail: `${t("provisioning.detail.migrationFallback")}` },
          }));
          logMigrationNote(`token issue failed: ${issueError instanceof Error ? issueError.message : String(issueError)}`);
          issuedToken = null;
        }
      }
      // The fallback leg: download through this computer, verify the digest
      // when one is known, upload from the local file.
      const downloaded = await downloadMigrationArchive(activeSession);
      if (backupCancelledRef.current) {
        if (downloaded.ok && downloaded.downloadedPath !== undefined) {
          void window.spaceBackup?.deleteTemp(downloaded.downloadedPath);
        }
        returnToFormCancelled();
        return;
      }
      if (!downloaded.ok) {
        backupFailed(downloaded.error ?? "the archive download failed");
        return;
      }
      const archivePath = downloaded.downloadedPath ?? null;
      const expectedDigest = issuedToken !== null ? issuedToken.archiveSha256 : digest;
      if (archivePath !== null && expectedDigest != null && window.spaceProvisioning !== undefined) {
        const actualDigest = await window.spaceProvisioning.hashFile(archivePath);
        if (actualDigest !== null && actualDigest !== expectedDigest) {
          void window.spaceBackup?.deleteTemp(archivePath);
          backupFailed(t("provisioning.err.migrationDigest"));
          return;
        }
        if (actualDigest === null) {
          logMigrationNote("the local digest check was skipped (the file could not be hashed)");
        }
      }
      setSteps((previous) => ({ ...previous, backup: { state: "done" } }));
      restoreArmedRef.current = true;
      void window.spaceProvisioning?.start({
        ...baseParams,
        backupArchivePath: archivePath,
        migrationArchive: true,
      });
    } finally {
      if (issuedToken !== null) {
        // The token is spent on the fallback route (or the direct leg never
        // started) — withdraw it right away; the direct leg's token lives on
        // until the server-side transfer consumes the archive (deliver-and-
        // delete) or the TTL sweeps it.
        void activeSession.rest.revokeMigrationTransfer().catch(() => undefined);
      }
      if (backupCancelledRef.current) {
        releaseBackupScheduleFor(activeSession.recordId);
      }
    }
  };

  /** Cancels of the source step: clear the step-live flag, back to the form. */
  const returnToFormCancelled = (): void => {
    backupStepLiveRef.current = false;
    setPhase("form");
    setSteps({});
  };

  /** A failed source step: the form carries the error. */
  const backupFailed = (message: string): void => {
    backupStepLiveRef.current = false;
    setSteps((previous) => ({ ...previous, backup: { state: "failed" } }));
    setError(message);
    setPhase("failed");
  };

  /** A note for the diagnostics log (the fallback reasons must be traceable). */
  const logMigrationNote = (message: string): void => {
    setSteps((previous) => ({ ...previous, backup: { state: "log", detail: message } }));
  };

  if (phase === "running" || phase === "loggingIn" || phase === "needsLogin") {
    return (
      <div className="prov-progress">
        <div className="prov-steps">
          {STAGE_ORDER
            .filter((stage) => (stage !== "backup" || mode === "migrate")
              && (stage !== "firewall" || firewall)
              && (stage !== "restore" || restoreArmedRef.current)
              && (stage !== "register" || !restoreArmedRef.current))
            .map((stage) => {
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
                <span className="prov-step-label">{t(STAGE_LABEL_KEYS[stage])}</span>
                {step?.progress !== undefined && status === "running"
                  ? <span className="prov-step-progress">{step.progress}</span>
                  : null}
                {step?.detail !== undefined && status !== "pending"
                  ? <span className="prov-step-detail">{step.detail}</span>
                  : null}
              </div>
            );
          })}
        </div>
        {phase === "running" ? (
          <>
            <div className="settings-hint">{t("provisioning.firstRunHint")}</div>
            <details className="prov-log">
              <summary>{t("provisioning.details")}</summary>
              <div className="prov-log-lines">{logLines.join("\n")}</div>
            </details>
            <div className="modal-actions">
              <button className="ghost" onClick={() => {
                // While the backup step is live there is no SSH run to tear —
                // the flag stops the flow, the temp file is cleaned up, the
                // form returns (no failure reported).
                if (backupStepLiveRef.current) {
                  backupCancelledRef.current = true;
                  return;
                }
                void window.spaceProvisioning?.cancel();
              }}>{t("common.cancel")}</button>
            </div>
          </>
        ) : phase === "loggingIn" ? (
          <div className="settings-hint">{t("provisioning.loggingIn")}</div>
        ) : (
          <>
            <div className="settings-hint">
              {restoredOutcome ? t("provisioning.needsLoginRestored") : t("provisioning.needsLogin")}
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => {
                if (mode === "migrate" && onDone !== undefined) {
                  onDone();
                } else {
                  setPhase("form");
                }
              }}>{t("share.back")}</button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="prov-form">
      <div className="settings-hint">
        {mode === "migrate" ? t("provisioning.migrateIntro") : t("provisioning.introHint")}
      </div>
      <label className="settings-field">
        <span>{t("provisioning.hostLabel")}</span>
        <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="203.0.113.10" autoFocus />
      </label>
      <label className="settings-field">
        <span>{t("provisioning.sshUser")}</span>
        <input type="text" value={sshLogin} onChange={(event) => setSshLogin(event.target.value)} placeholder="root" autoComplete="off" />
      </label>
      <label className="settings-field">
        <span>{t("provisioning.sshPassword")}</span>
        <PasswordInput value={sshPassword} onChange={setSshPassword} placeholder={t("provisioning.sshPasswordHint")} autoComplete="off" />
      </label>
      {/* Server credentials above / Space account below (user request
          2026-10-15): a rule makes the two groups read as separate blocks.
          In MIGRATE mode the account block is gone entirely — the accounts
          come from the archive, there is nothing to register. */}
      {mode === "migrate" ? null : (
        <>
          <div className="prov-section-rule" />
          <label className="settings-field">
            <span>{t("provisioning.accountLogin")}</span>
            <input
              type="text"
              value={accountLogin}
              onChange={(event) => setAccountLogin(event.target.value)}
              placeholder={DEFAULT_ACCOUNT_LOGIN}
              autoComplete="off"
            />
          </label>
          <label className="settings-field">
            <span>{t("provisioning.accountNickname")}</span>
            <input
              type="text"
              value={accountNickname}
              onChange={(event) => setAccountNickname(event.target.value)}
              placeholder={DEFAULT_ACCOUNT_LOGIN}
              autoComplete="off"
            />
          </label>
          <label className="settings-field">
            <span>{t("provisioning.accountPassword")}</span>
            <PasswordInput
              value={accountPassword}
              onChange={setAccountPassword}
              onEnter={submit}
              placeholder={DEFAULT_ACCOUNT_PASSWORD}
              autoComplete="new-password"
            />
          </label>
          <div className="settings-hint">
            {t("provisioning.defaultsHint", { login: DEFAULT_ACCOUNT_LOGIN, password: DEFAULT_ACCOUNT_PASSWORD })}
          </div>
        </>
      )}
      <details className="prov-advanced">
        <summary>{t("provisioning.advanced")}</summary>
        <label className="settings-field">
          <span>{t("provisioning.sshPort")}</span>
          <input type="text" value={sshPort} onChange={(event) => setSshPort(event.target.value)} placeholder="22" />
        </label>
        <label className="settings-field">
          <span>{t("provisioning.keyFile")}</span>
          <input type="text" value={sshKeyPath} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
        </label>
        {sshKeyPath.trim().length > 0 ? (
          <label className="settings-field">
            <span>{t("provisioning.keyPassphrase")}</span>
            <PasswordInput value={sshKeyPassphrase} onChange={setSshKeyPassphrase} placeholder={t("provisioning.keyPassphraseHint")} autoComplete="off" />
          </label>
        ) : null}
        <label className="settings-field">
          <span>{t("provisioning.domain")}</span>
          <input type="text" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="oak.example.com" />
        </label>
        <label className="settings-field prov-check">
          <input type="checkbox" checked={firewall} onChange={(event) => setFirewall(event.target.checked)} />
          <span>{t("provisioning.firewall")}</span>
        </label>
        <label className="settings-field">
          <span>{t("provisioning.jarOverride")}</span>
          <input type="text" value={jarPath} onChange={(event) => setJarPath(event.target.value)} placeholder="C:\Users\you\Downloads\oak-server.jar" />
        </label>
        {mode === "migrate" ? (
          <div className="settings-hint">{t("provisioning.migrateArchiveNote")}</div>
        ) : (
          <>
            <label className="settings-field">
              <span>{t("provisioning.restoreArchive")}</span>
              <span className="prov-archive-row">
                <input type="text" value={backupArchivePath} onChange={(event) => setBackupArchivePath(event.target.value)} placeholder="C:\Users\you\Downloads\SPACE\backup\server-backup-…" />
                <button type="button" onClick={() => {
                  void window.spaceBackup?.chooseArchive().then((chosen) => {
                    if (chosen !== null) {
                      setBackupArchivePath(chosen);
                    }
                  });
                }}>{t("backup.chooseFolder")}</button>
              </span>
            </label>
            {backupArchivePath.trim().length > 0 ? (
              <div className="settings-hint">{t("provisioning.restoreHint")}</div>
            ) : null}
          </>
        )}
      </details>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="primary" onClick={submit}>
          {mode === "migrate" ? t("provisioning.migrateVerb") : t("provisioning.setupVerb")}
        </button>
      </div>
    </div>
  );
}
