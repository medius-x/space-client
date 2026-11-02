/**
 * The provisioning pipeline (round C): everything a fresh Ubuntu server needs
 * to become a running OAK deployment — Docker, /opt/oak with the compose
 * stack, per-deployment secrets, a TLS certificate, a firewall and the OWNER
 * account — driven over SSH from the client's main process.
 *
 * The pipeline is a PURE function of its seams: the transport (exec/writeFile/
 * readFile — ssh2 in production, a scriptable fake in tests), the file
 * templates and the random source. The caller (electron/provisioning.ts) owns
 * connecting, the jar bytes, the TOFU pin registration and the IPC events.
 *
 * Idempotency contract: a live /opt/oak/docker-compose.yml switches the run
 * into ADOPT mode — templates are refreshed and the stack is rebuilt, but the
 * .env secrets and the self-signed certificate are NEVER touched (client pins
 * survive), and `docker compose down -v` is never run.
 */
import { buildEnvFile, generateEnvSecrets, type RandomHexSource } from "./env-file";
import { clipProgressLine, formatByteProgress } from "./progress";
import type { ProvisioningParams } from "./params";
import { enTranslator, type Translator } from "../i18n/i18n";
import {
  caddyFileForMode,
  composeImageRefs,
  extractJsonObject,
  parseCurlWithStatus,
  parseOpensslFingerprint,
  selfSignedSan,
  serverJarUrl,
  serverKitAssetUrl,
  type ImageManifestEntry,
  type ProvisioningKit,
} from "./artifacts";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the remote process died to a SIGNAL (the kernel OOM killer
   *  leaves no error line — live 2026-10-28); null for ordinary exits and
   *  optional so fake transports can omit it. */
  signal?: string | null;
}

/** The SSH seam — implemented by Ssh2Transport in the main process. */
export interface ProvisioningTransport {
  /** onOutputLine fires per COMPLETE line of the command's combined output —
   *  the pipeline surfaces it as the step's live progress text. */
  exec(command: string, options?: { timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<ExecResult>;
  /** Re-establishes the connection after a drop using the SAME credentials;
   *  false when it cannot (or the run was cancelled). Optional seam — fake
   *  transports implement it only when a test exercises the resume ladder. */
  reconnect?(): Promise<boolean>;
  /** True while the underlying connection is alive (a resume skips the
   *  reconnect when the drop killed only the channel). */
  isConnected?(): boolean;
  writeFile(remotePath: string, contents: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  readFile(remotePath: string): Promise<string | null>;
  /** Streams a LOCAL file to the remote path (the image archives: hundreds of
   *  megabytes must never be buffered in memory). onProgress fires with the
   *  REAL byte counts of the transfer (throttling is the caller's job). */
  writeLocalFile(
    localPath: string,
    remotePath: string,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
  ): Promise<void>;
}

/** The bundled image set (files/images/*, manifest.json) — the registry-free
 *  fallback: digest-pinned references the compose stack uses, each with its
 *  docker-save archive. Missing images deploy from here BEFORE any pull. */
export interface ProvisioningImageSet {
  manifest: ImageManifestEntry[];
  /** The local directory holding the archives (main passes it in). */
  directory: string;
}

/** The deployment file set, read from electron/provisioning/files by the host. */
export interface ProvisioningFiles {
  composeFile: string;
  dockerfileServer: string;
  janusDockerfile: string;
  janusConfig: string;
  janusHttpConfig: string;
  caddyFileTemplate: string;
  /** An explicit jar path from the Advanced section — ALWAYS wins over every
   *  other source (user decision 2026-10-12); null in the normal flow. */
  jarOverridePath: string | null;
  /** The jar bundled with this build (full kit); null in the light kit. */
  jarBundledPath: string | null;
  /** The client's own version — the GitHub tag behind every server-kit asset
   *  URL (parity: the kit of THIS client, never "latest"). */
  kitVersion: string;
  /** The build's kit marker (kit.json): "full" bundles the server kit in
   *  extraResources, "light" fetches everything big at provisioning time.
   *  An absent marker (pre-0.4.0 installs, dev tree) reads as "full". */
  kit: ProvisioningKit;
  /** The digest-pinned image manifest — ALWAYS present in both kits (the
   *  light build strips the tarballs but keeps manifest.json): the pull
   *  ladder's pin source and the GitHub asset URL/size list. */
  imageManifest: ImageManifestEntry[];
  /** Null when the build ships no bundled image archives (light kit, or a
   *  full build whose archives were cleaned away — such installs behave like
   *  light at the terminal stage, they do NOT fail). */
  images: ProvisioningImageSet | null;
}

/** The host-side large-file downloader (electron/provisioning.ts injects its
 *  downloadToFile): fetches a kit asset to a LOCAL temp file and resolves to
 *  its path. The light kit's client-side fallback — the home link joins the
 *  byte path only when the server itself cannot reach GitHub. */
export type ClientFileDownloader = (
  url: string,
  fileName: string,
  onProgress: (bytesReceived: number, bytesTotal: number | null) => void,
) => Promise<string>;

export type ProvisioningStage =
  | "probe"
  | "docker"
  | "layout"
  | "upload"
  | "env"
  | "certificate"
  | "firewall"
  | "compose"
  | "wait"
  | "restore"
  | "register";

export interface ProvisioningStepEvent {
  stage: ProvisioningStage;
  state: "start" | "done" | "log" | "failed";
  detail?: string;
  /** Live progress of the ACTIVE step (user decision 2026-10-15), rendered
   *  after the step name and before the detail: a byte counter for uploads
   *  ("34.2 / 79.1 MB · 43%") or the running command's last output line
   *  (docker/compose have no honest percentage). Absent on done/failed — the
   *  UI clears the slot with the step's completion. */
  progress?: string;
}

/** The terminal outcome handed to the renderer for the automatic login. */
export interface ProvisioningOutcome {
  hostUrl: string;
  /** The self-signed certificate's normalized SHA-256 pin — null on a domain
   *  deployment (CA-signed, nothing to pin). */
  certFingerprint: string | null;
  /** True when the admin account accepts the password the user typed (fresh
   *  registration, or an adopt re-run whose existing account logged in). */
  ownerReady: boolean;
  /** The registered Space account login (the automatic login's username). */
  adminUsername: string;
  /** True when the deployment RESTORED a backup archive instead of registering
   *  (backup round 2026-10-28): accounts and conversations come from the
   *  archive, the owner's password is known to the user alone — the finish
   *   phase is needsLogin, no automatic login is attempted. */
  restored: boolean;
}

/** A step failure carrying the stage it died on (for the UI's step list). */
export class ProvisioningFailure extends Error {
  constructor(
    public readonly stage: ProvisioningStage,
    message: string,
  ) {
    super(message);
  }
}

const REMOTE_ROOT = "/opt/oak";
const CERT_PATH = `${REMOTE_ROOT}/caddy/certs/tls.crt`;

// Long-running steps: the docker install pulls packages, the first compose up
// builds two images (temurin JRE base + janus), the readiness poll waits out
// Spring Boot's boot with Flyway migrations on a fresh database.
const DOCKER_INSTALL_TIMEOUT_MS = 600_000;
/** A full dist-upgrade of a fresh Ubuntu: hundreds of MB to fetch and unpack. */
const SYSTEM_UPGRADE_TIMEOUT_MS = 1_200_000;
const OPENSSL_TIMEOUT_MS = 60_000;
const FIREWALL_INSTALL_TIMEOUT_MS = 300_000;
const COMPOSE_UP_TIMEOUT_MS = 900_000;
const READINESS_TIMEOUT_MS = 420_000;
const IMAGE_LOAD_TIMEOUT_MS = 300_000;
/** One image, one pull — a big layer set on a slow path can take minutes. */
const SINGLE_PULL_TIMEOUT_MS = 600_000;

// Connection-loss resilience (live 2026-10-28: a network drop 50 s into a
// dist-upgrade killed the run, while the server-side apt kept running and
// finished fine 5.5 minutes later). The interrupted command is re-run after a
// bounded reconnect — every step here is idempotent by design (the same
// contract that makes the whole run user-restartable), so a resume is a
// re-entry, never a duplicate side effect.
const CONNECTION_RESUME_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000];
/** A re-run of an interrupted apt/dpkg command must first wait out the GHOST
 *  of the dropped session: the old apt keeps running server-side after the
 *  channel dies and holds the dpkg lock — a naive re-run would fail on
 *  "could not get lock" instantly (the live incident: ghost ran 5.5 min). */
const GHOST_PACKAGE_WAIT_MS = 600_000;
const GHOST_PACKAGE_POLL_MS = 5_000;
const GHOST_PACKAGE_CHECK = "pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1";
const GHOST_PACKAGE_TRIGGER = /apt|dpkg|get\.docker/;

// Server-side downloads (the downloadOnServer contract): reachability probe,
// poll cadence, the no-growth stall budget and the manual restarts on top of
// curl's own --retry. A transfer that neither grows nor dies for the stall
// budget is killed; one that died incomplete is restarted (curl -C - resumes
// where the partial file stopped).
const URL_PROBE_TIMEOUT_MS = 10_000;
const SERVER_DOWNLOAD_POLL_MS = 2_000;
const SERVER_DOWNLOAD_STALL_MS = 300_000;
const SERVER_DOWNLOAD_RESTARTS = 2;

/** Single-quotes a value for a remote shell command (the ladder's URLs and
 *  paths are pre-validated, but the quoting must survive any future caller). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parses the missing-check output ("MISSING ref" per line). */
function parseMissingImages(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("MISSING "))
    .map((line) => line.slice("MISSING ".length).trim())
    .filter((line) => line.length > 0);
}

/** Turns a failed exec into the failure text the user sees. The output TAIL
 *  alone hides the class of death (live 2026-10-28: a dist-upgrade killed by
 *  a signal surfaced as a bare "Reading database … 55%" apt progress line);
 *  the exit status names it — a signal is the kernel's signature (SIGKILL on
 *  a small VPS is typically the OOM killer), and a missing status means the
 *  ssh channel died before the process could report one. */
export function describeExecFailure(result: ExecResult): string {
  const tail = (result.stderr.trim() || result.stdout.trim())
    .split("\n")
    .slice(-8)
    .join(" | ");
  if (typeof result.signal === "string" && result.signal.length > 0) {
    const oomHint = result.signal === "SIGKILL" ? " (typically the kernel OOM killer)" : "";
    return `the command was killed by ${result.signal}${oomHint}${tail ? ` · ${tail}` : ""}`;
  }
  if (result.code === -1) {
    return `the ssh channel closed without an exit status${tail ? ` · ${tail}` : ""}`;
  }
  return tail ? `${tail} · exit code ${result.code}` : `exit code ${result.code}`;
}

type EmitFn = (event: ProvisioningStepEvent) => void;

/** Thrown by the transport when the SSH CONNECTION (not the command) died —
 *  no exit status, no signal. The pipeline answers it with a bounded
 *  reconnect + idempotent re-run instead of failing the whole deployment. */
export class ConnectionLostError extends Error {
  constructor(message = "the ssh connection was lost during the command") {
    super(message);
  }
}

export async function runProvisioningPipeline(
  transport: ProvisioningTransport,
  params: ProvisioningParams,
  files: ProvisioningFiles,
  emit: EmitFn,
  randomHex: RandomHexSource,
  /** The step-detail translator (localization round): defaults to English so
   *  the pre-i18n pipeline tests stay green; electron/provisioning.ts passes a
   *  closure reading the CURRENT main-process language — a language flip
   *  mid-run recolors the steps that have not fired yet. */
  t: Translator = enTranslator,
  /** The pause seam of the resume ladder (reconnect backoff, ghost polling) —
   *  tests inject an instant no-op instead of waiting real seconds. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /** The host's large-file downloader (the light kit's client-side fallback):
   *  fetches a URL to a local temp file. Optional — without it the pipeline
   *  has no client-side download leg and the ladder ends at the bundled jar. */
  clientFileDownloader?: ClientFileDownloader,
): Promise<ProvisioningOutcome> {
  const domainDeployment = params.domain !== null && params.domain.trim().length > 0;
  const publicHost = (domainDeployment ? params.domain! : params.host).trim();
  const hostUrl = `https://${publicHost}`;

  /** Waits out a GHOST package manager left running by the dropped session —
   *  bounded, best-effort: a check that itself loses the connection simply
   *  returns, and the ladder's next iteration deals with the drop. */
  const waitForGhostPackages = async (stage: ProvisioningStage): Promise<void> => {
    const deadline = Date.now() + GHOST_PACKAGE_WAIT_MS;
    let announced = false;
    while (Date.now() < deadline) {
      let ghostAlive: boolean;
      try {
        const result = await transport.exec(GHOST_PACKAGE_CHECK, { timeoutMs: 30_000 });
        ghostAlive = result.code === 0;
      } catch {
        return;
      }
      if (!ghostAlive) {
        return;
      }
      if (!announced) {
        announced = true;
        emit({ stage, state: "log", detail: t("provisioning.detail.ghostWait") });
      }
      await sleep(GHOST_PACKAGE_POLL_MS);
    }
  };

  /** Runs an operation and RESUMES it across an ssh drop: visible reconnect
   *  line → bounded backoff → reconnect with the same credentials → (for apt/
   *  dpkg commands) wait for the ghost of the killed session → idempotent
   *  re-run. Exhausted budget = an honest failure with its own message. */
  const resumeOnDrop = async <T>(
    stage: ProvisioningStage,
    operation: () => Promise<T>,
    commandForGhostCheck?: string,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) {
          throw error;
        }
        if (attempt >= CONNECTION_RESUME_ATTEMPTS) {
          throw new ProvisioningFailure(stage, t("provisioning.err.connectionDropped"));
        }
      }
      emit({
        stage,
        state: "log",
        detail: t("provisioning.detail.reconnecting", { attempt: attempt + 1, total: CONNECTION_RESUME_ATTEMPTS }),
      });
      await sleep(RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]!);
      if (transport.isConnected?.() !== true) {
        const reconnected = transport.reconnect ? await transport.reconnect() : false;
        if (!reconnected) {
          throw new ProvisioningFailure(stage, t("provisioning.err.connectionDropped"));
        }
      }
      if (commandForGhostCheck !== undefined && GHOST_PACKAGE_TRIGGER.test(commandForGhostCheck)) {
        await waitForGhostPackages(stage);
      }
    }
  };

  /** A plain exec with the same drop-resume as must() (no exit-code gate) —
   *  the pipeline's bare probe/read commands ride the same ladder. */
  const run = (
    stage: ProvisioningStage,
    command: string,
    options?: { timeoutMs?: number; onOutputLine?: (line: string) => void },
  ): Promise<ExecResult> => resumeOnDrop(stage, () => transport.exec(command, options), command);

  /** Runs a command; a non-zero exit raises with the stage's name attached. */
  const must = async (
    stage: ProvisioningStage,
    command: string,
    options?: { timeoutMs?: number; onOutputLine?: (line: string) => void },
  ): Promise<ExecResult> => {
    const result = await run(stage, command, options);
    if (result.code !== 0) {
      throw new ProvisioningFailure(stage, describeExecFailure(result));
    }
    return result;
  };

  /** writeFile/writeLocalFile with the same drop-resume: SFTP writes are
   *  idempotent overwrites, so a re-run heals a truncated remote file. The
   *  optional mode serves the migration leg's 0600 credential files. */
  const mustWrite = (
    stage: ProvisioningStage,
    remotePath: string,
    contents: string | Uint8Array,
    options?: { mode?: number },
  ): Promise<void> => resumeOnDrop(stage, () => transport.writeFile(remotePath, contents, options));
  const mustUpload = (
    stage: ProvisioningStage,
    localPath: string,
    remotePath: string,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
  ): Promise<void> => resumeOnDrop(stage, () => transport.writeLocalFile(localPath, remotePath, onProgress));

  /** Rate-limited progress text for the ACTIVE step (user decision
   *  2026-10-15): per-chunk callbacks must not flood the IPC. Unchanged text
   *  repeats at most once a second; a forced flush rides along with the
   *  step's own done event. */
  const progressEmitter = (stage: ProvisioningStage) => {
    let lastSentAt = 0;
    let lastText = "";
    return (text: string): void => {
      const now = Date.now();
      const sameText = text === lastText;
      if (now - lastSentAt < (sameText ? 1000 : 250)) {
        return;
      }
      lastSentAt = now;
      lastText = text;
      emit({ stage, state: "log", progress: text });
    };
  };

  /** Clears a FOREIGN partial before a server-side download: a leftover from a
   *  DIFFERENT run or version must never be doclined onto the new archive
   *  (curl -C - would happily glue it). An EXACT size match is kept — the
   *  transfer then finishes instantly, preserving the cross-run resume of a
   *  half-delivered file of the same version. */
  const clearForeignPartial = async (stage: ProvisioningStage, dest: string, expectedBytes: number): Promise<void> => {
    await run(stage, `size=$(stat -c %s ${shellQuote(dest)} 2>/dev/null || echo -1); `
      + `if [ "$size" != ${expectedBytes} ]; then rm -f ${shellQuote(dest)}; fi`);
  };

  /** Probes a URL FROM THE SERVER (curl is guaranteed by the probe step):
   *  reachable + the FINAL hop's Content-Length (GitHub's asset URLs redirect
   *  to a CDN — -L follows, the last header wins). A probe without a usable
   *  length counts as NOT reachable: without the expected size the download
   *  loop below has no honest done-condition. */
  const probeServerUrl = async (
    stage: ProvisioningStage,
    url: string,
  ): Promise<{ reachable: true; contentLength: number } | { reachable: false }> => {
    const probeCommand = `curl -fsSIL --max-time ${Math.round(URL_PROBE_TIMEOUT_MS / 1000)} ${shellQuote(url)} 2>/dev/null`
      + ` | tr -d '\\r' | grep -i '^content-length:' | tail -1`;
    const result = await run(stage, probeCommand);
    if (result.code !== 0) {
      return { reachable: false };
    }
    const length = Number.parseInt(result.stdout.split(":")[1] ?? "", 10);
    return Number.isFinite(length) && length > 0 ? { reachable: true, contentLength: length } : { reachable: false };
  };

  /** A server-side background download (the unified big-content ladder, user
   *  decision 2026-11-02: the client's home link stays OUT of the byte path
   *  whenever the server itself can reach the source). The transfer runs
   *  DETACHED from the ssh channel — setsid with redirected stdio, or the exec
   *  would hang on the unclosed inherited FDs and a channel death would
   *  SIGPIPE the transfer mid-flight. The loop then polls the destination's
   *  size and the transfer's liveness (pid file + kill -0).
   *
   *  Idempotent under the resume ladder: a re-entry after an ssh drop finds
   *  the live transfer (its pid still owns the dest in /proc/<pid>/cmdline)
   *  and just keeps polling; `curl -C -` resumes a dead transfer from the
   *  partial file. Post-run leftovers from a DIFFERENT run must be removed by
   *  the CALLER before the first call (a foreign partial would otherwise be
   *  doclined onto the new archive). */
  const downloadOnServer = async (
    stage: ProvisioningStage,
    request: {
      url: string;
      dest: string;
      expectedBytes: number;
      label: string;
      onProgress?: (bytesReceived: number) => void;
      /** The migration leg's auth/TLS: headers read from a 0600 file (never
       *  the command line — ps on the server would see them) and a pinned
       *  CA certificate. */
      headerFile?: string;
      cacertFile?: string;
    },
  ): Promise<void> => resumeOnDrop(stage, async () => {
    const safeLabel = request.label.replace(/[^A-Za-z0-9._-]/g, "_");
    const logFile = `/tmp/space-dl-${safeLabel}.log`;
    const pidFile = `/tmp/space-dl-${safeLabel}.pid`;
    const authArgs = request.headerFile !== undefined ? ` -H @${shellQuote(request.headerFile)}` : "";
    const tlsArgs = request.cacertFile !== undefined ? ` --cacert ${shellQuote(request.cacertFile)}` : "";
    const transferCommand = `exec curl -fsS -C - --retry 3 --retry-connrefused${authArgs}${tlsArgs}`
      + ` -o ${shellQuote(request.dest)} ${shellQuote(request.url)}`;
    const startTransfer = `setsid sh -c ${shellQuote(transferCommand)} </dev/null >/dev/null 2>${shellQuote(logFile)} & echo $! > ${shellQuote(pidFile)}`;
    // Start ONLY when no live transfer already owns this dest (the resume
    // re-entry path); the /proc cmdline check also rules out a reused pid.
    const ensureTransfer = `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null || echo 0); `
      + `if [ "$pid" != 0 ] && kill -0 "$pid" 2>/dev/null `
      + `&& tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -qF -- ${shellQuote(request.dest)}; then `
      + `echo RESUMED; else ${startTransfer}; fi`;
    await must(stage, ensureTransfer);
    const pollCommand = `size=$(stat -c %s ${shellQuote(request.dest)} 2>/dev/null || echo 0); `
      + `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null || echo 0); `
      + `if [ "$pid" != 0 ] && kill -0 "$pid" 2>/dev/null; then alive=1; else alive=0; fi; `
      + `echo "$size $alive $pid"`;
    let lastSize = -1;
    let lastGrowthAt = Date.now();
    let restartsLeft = SERVER_DOWNLOAD_RESTARTS;
    for (;;) {
      const poll = await run(stage, pollCommand, { timeoutMs: 30_000 });
      const match = /^(\d+) ([01]) (\d+)$/.exec(poll.stdout.trim());
      if (match === null) {
        throw new ProvisioningFailure(stage, t("provisioning.err.serverDownload", { label: request.label, reason: "status unreadable" }));
      }
      const size = Number(match[1]);
      const alive = match[2] === "1";
      const pid = Number(match[3]);
      if (size >= request.expectedBytes) {
        // Checked BEFORE any restart: a completed file must never be re-fetched
        // (curl -C - on a full file is a no-op, but a size check is cheaper
        // and immune to Content-Length quirks).
        return;
      }
      if (size > lastSize) {
        lastSize = size;
        lastGrowthAt = Date.now();
        request.onProgress?.(size);
      } else if (alive && Date.now() - lastGrowthAt >= SERVER_DOWNLOAD_STALL_MS) {
        // Kill ONLY the verified owner: the pid is re-checked against
        // /proc/<pid>/cmdline right before the signal (a reused pid must not
        // receive a group kill).
        const verify = await run(stage, `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null`);
        if (verify.stdout.includes(request.dest)) {
          await run(stage, `kill -- -${pid} 2>/dev/null; rm -f ${shellQuote(pidFile)}`);
        }
        throw new ProvisioningFailure(stage, t("provisioning.err.serverDownload", {
          label: request.label,
          reason: `no progress for ${Math.round(SERVER_DOWNLOAD_STALL_MS / 1000)} s`,
        }));
      }
      if (!alive) {
        if (restartsLeft > 0) {
          restartsLeft -= 1;
          await must(stage, startTransfer);
          lastGrowthAt = Date.now();
          continue;
        }
        const tail = (await run(stage, `tail -3 ${shellQuote(logFile)}`)).stdout.trim().replace(/\n/g, " | ");
        throw new ProvisioningFailure(stage, t("provisioning.err.serverDownload", {
          label: request.label,
          reason: tail.length > 0 ? tail : "the transfer died before completing",
        }));
      }
      await sleep(SERVER_DOWNLOAD_POLL_MS);
    }
  });

  try {
    // ── probe: OS + docker presence ─────────────────────────────────────
    emit({ stage: "probe", state: "start" });
    const kernel = await must("probe", "uname -s");
    const osName = kernel.stdout.trim();
    if (osName !== "Linux") {
      throw new ProvisioningFailure("probe", t("provisioning.err.linuxOnly", { os: osName }));
    }
    const release = await run("probe", `. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "unknown Linux"`);
    // curl drives the readiness poll and the registration calls below — some
    // minimal cloud images ship without it.
    await must("probe", "command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl)", {
      timeoutMs: FIREWALL_INSTALL_TIMEOUT_MS,
    });

    // ── host requirements: refuse EARLY, before minutes of work ─────────
    // A host below the floors cannot hold the stack (the 2 GB VPS saga:
    // OOM races at start, live 2026-10-12) — the check up front turns a
    // 15-minute doomed run into a 5-second honest refusal (user request
    // 2026-10-13). The meminfo numbers are read ONCE here and reused by the
    // small-host swap guard below.
    const DISK_FLOOR_MB = 5_120;
    const RAM_FLOOR_KB = 1_200_000;
    const diskResult = await run("probe", "df -Pm / | awk 'NR==2 {print $4}'");
    // parseInt (not Number): an EMPTY output parses to NaN and the check is
    // skipped, while Number("") would read as 0 and refuse a healthy host.
    const diskFreeMb = Number.parseInt(diskResult.stdout.trim(), 10);
    const meminfo = await run("probe", "awk '/^MemTotal|^SwapTotal/ {print $2}' /proc/meminfo");
    const [memTotalKb, swapTotalKb] = meminfo.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const memoryNumbersKnown = memTotalKb !== undefined && swapTotalKb !== undefined
      && Number.isFinite(memTotalKb) && Number.isFinite(swapTotalKb);
    // Some providers cap a VM below its advertised RAM through a root cgroup
    // memory limit — inside a capped VM the kernel OOM killer looks exactly
    // like missing RAM (the suspicion checked by hand on the live VPS,
    // 2026-10-13), so the cap counts against the same floor.
    const cgroupLimit = await run("probe", "cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max");
    const cgroupLimitKb = Number.parseInt(cgroupLimit.stdout.trim(), 10);
    const gigabytes = (kb: number): string => `${(kb / 1_000_000).toFixed(1)} GB`;
    if (Number.isFinite(diskFreeMb) && diskFreeMb < DISK_FLOOR_MB) {
      throw new ProvisioningFailure(
        "probe",
        t("provisioning.err.disk", { free: Math.round(diskFreeMb / 1024), need: Math.round(DISK_FLOOR_MB / 1024) }),
      );
    }
    if (memoryNumbersKnown && memTotalKb < RAM_FLOOR_KB) {
      throw new ProvisioningFailure(
        "probe",
        t("provisioning.err.ram", { ram: gigabytes(memTotalKb), need: gigabytes(RAM_FLOOR_KB) }),
      );
    }
    if (Number.isFinite(cgroupLimitKb) && cgroupLimitKb < RAM_FLOOR_KB) {
      throw new ProvisioningFailure(
        "probe",
        t("provisioning.err.cgroup", { cap: gigabytes(cgroupLimitKb), need: gigabytes(RAM_FLOOR_KB) }),
      );
    }

    const dockerProbe = await run("probe", "docker --version && docker compose version");
    const dockerPresent = dockerProbe.code === 0;
    emit({
      stage: "probe",
      state: "done",
      detail: t(memoryNumbersKnown && Number.isFinite(diskFreeMb)
        ? "provisioning.detail.probeDoneFull"
        : "provisioning.detail.probeDoneShort", {
        os: release.stdout.trim() || "Linux",
        docker: t(dockerPresent ? "provisioning.detail.dockerPresent" : "provisioning.detail.dockerMissing"),
        ram: memoryNumbersKnown ? gigabytes(memTotalKb) : "",
        swap: memoryNumbersKnown ? gigabytes(swapTotalKb) : "",
        disk: Number.isFinite(diskFreeMb) ? String(Math.round(diskFreeMb / 1024)) : "",
      }),
    });

    // ── docker: system refresh + install when absent ─────────────────────
    // SYSTEM UPDATE FIRST (user decision, 2026-10-13): a fresh OS boots with
    // unattended-upgrades already churning in the background — it OOM-raced
    // the stack start three installs in a row on the 2 GB VPS (journal: minio
    // + unattended-upgr killed in the same minutes). The pipeline stops the
    // updater, upgrades the system DETERMINISTICALLY, and disables the
    // updater for good — package upgrades on a dedicated OAK server are the
    // owner's deliberate act, never a background one.
    emit({ stage: "docker", state: "start", detail: t("provisioning.detail.dockerStart") });
    // No honest percentage exists for apt/docker output — the step surfaces the
    // running command's LAST OUTPUT LINE instead (a moving line separates
    // "slow" from "hung" on a fresh host's multi-minute install).
    const dockerProgress = progressEmitter("docker");
    const dockerLine = (line: string): void => {
      const clipped = clipProgressLine(line);
      if (clipped.length > 0) {
        dockerProgress(clipped);
      }
    };
    await must(
      "docker",
      "systemctl stop unattended-upgrades apt-daily-upgrade 2>/dev/null; "
        + "systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1; true",
    );
    // The updater may hold the dpkg lock mid-install — wait it out (a killed
    // updater also leaves half-installed packages behind; configure -a fixes).
    await must(
      "docker",
      "for attempt in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || exit 0; sleep 5; done; echo 'the dpkg lock is still held'; exit 1",
      { timeoutMs: 360_000 },
    );
    await must("docker", "dpkg --configure -a", { timeoutMs: 600_000, onOutputLine: dockerLine });
    await must(
      "docker",
      "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -qq dist-upgrade",
      { timeoutMs: SYSTEM_UPGRADE_TIMEOUT_MS, onOutputLine: dockerLine },
    );
    emit({ stage: "docker", state: "log", detail: t("provisioning.detail.packagesUpdated") });
    const rebootNeeded = await run("docker", "test -f /var/run/reboot-required && echo yes || echo no");
    if (rebootNeeded.code === 0 && rebootNeeded.stdout.trim() === "yes") {
      emit({ stage: "docker", state: "log", detail: t("provisioning.detail.rebootHint") });
    }

    if (!dockerPresent) {
      emit({ stage: "docker", state: "log", detail: t("provisioning.detail.installingDocker") });
      await must("docker", "curl -fsSL https://get.docker.com | sh", { timeoutMs: DOCKER_INSTALL_TIMEOUT_MS, onOutputLine: dockerLine });
      // The installer usually starts the daemon; make sure it is enabled too.
      await run("docker", "systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true");
      const verify = await run("docker", "docker compose version");
      if (verify.code !== 0) {
        throw new ProvisioningFailure("docker", t("provisioning.err.dockerNoAnswer"));
      }
      emit({ stage: "docker", state: "done", detail: t("provisioning.detail.dockerInstalled") });
    }
    if (dockerPresent) {
      emit({ stage: "docker", state: "done", detail: t("provisioning.detail.dockerReady") });
    }

    // ── layout: /opt/oak + the adopt check ──────────────────────────────
    emit({ stage: "layout", state: "start" });
    await must("layout", `mkdir -p ${REMOTE_ROOT}/caddy/certs ${REMOTE_ROOT}/janus`);
    const existingCompose = await resumeOnDrop("layout", () => transport.readFile(`${REMOTE_ROOT}/docker-compose.yml`));
    const adopt = existingCompose !== null;
    // Restore mode (backup round 2026-10-28): the archive loads at oak's FIRST
    // boot — an adopted server already booted with its own data, and silently
    // replacing it with the archive is exactly the kind of surprise this flow
    // must never pull. Restores go to a FRESH machine. The archive arrives by
    // EITHER route (2026-11-02): the direct server-to-server transfer, or a
    // local file uploaded over SFTP — both are "restore mode".
    const restoreArchivePath = params.backupArchivePath !== null && params.backupArchivePath.trim().length > 0
      ? params.backupArchivePath.trim()
      : null;
    const migrationTransfer = params.migrationTransfer ?? null;
    if (restoreArchivePath !== null && adopt || migrationTransfer !== null && adopt) {
      throw new ProvisioningFailure("layout", t("provisioning.err.restoreAdopt"));
    }
    const restoreMode = restoreArchivePath !== null || migrationTransfer !== null;
    emit({
      stage: "layout",
      state: "done",
      detail: adopt
        ? t("provisioning.detail.adoptFound")
        : t("provisioning.detail.freshDeploy"),
    });

    // ── upload: templates + the server jar ──────────────────────────────
    emit({ stage: "upload", state: "start", detail: t("provisioning.detail.uploadingFiles") });
    // The jar is the one multi-megabyte item on this step — whichever leg
    // delivers it, its byte counter is the step's progress.
    const uploadProgress = progressEmitter("upload");
    await mustWrite("upload", `${REMOTE_ROOT}/docker-compose.yml`, files.composeFile);
    await mustWrite("upload", `${REMOTE_ROOT}/Dockerfile.server`, files.dockerfileServer);
    await mustWrite("upload", `${REMOTE_ROOT}/janus/Dockerfile`, files.janusDockerfile);
    await mustWrite("upload", `${REMOTE_ROOT}/janus/janus.jcfg`, files.janusConfig);
    await mustWrite("upload", `${REMOTE_ROOT}/janus/janus.transport.http.jcfg`, files.janusHttpConfig);
    await mustWrite("upload", `${REMOTE_ROOT}/caddy/Caddyfile`, caddyFileForMode(files.caddyFileTemplate, domainDeployment));
    // Jar ladder (user decision 2026-11-02 — the unified big-content rule):
    // the Advanced override ALWAYS wins; else the SERVER pulls the jar from
    // GitHub itself (the client's home link stays out of the byte path
    // whenever possible); else the local fallback (the bundled jar of the full
    // kit, or a client-side download in the light kit).
    const jarRemotePath = `${REMOTE_ROOT}/oak-server.jar`;
    const jarUploadProgress = (bytesSent: number, bytesTotal: number): void => {
      const text = formatByteProgress(bytesSent, bytesTotal);
      if (text.length > 0) {
        uploadProgress(`oak-server.jar ${text}`);
      }
    };
    let jarDelivered = false;
    if (files.jarOverridePath !== null) {
      await mustUpload("upload", files.jarOverridePath, jarRemotePath, jarUploadProgress);
      jarDelivered = true;
    } else {
      const jarUrl = serverJarUrl(files.kitVersion);
      const jarProbe = await probeServerUrl("upload", jarUrl);
      if (jarProbe.reachable) {
        emit({ stage: "upload", state: "log", detail: t("provisioning.detail.serverDownloadsJar") });
        try {
          await clearForeignPartial("upload", jarRemotePath, jarProbe.contentLength);
          await downloadOnServer("upload", {
            url: jarUrl,
            dest: jarRemotePath,
            expectedBytes: jarProbe.contentLength,
            label: "oak-server.jar",
            onProgress: (bytesReceived) => jarUploadProgress(bytesReceived, jarProbe.contentLength),
          });
          jarDelivered = true;
        } catch (error) {
          emit({
            stage: "upload",
            state: "log",
            detail: `${t("provisioning.detail.serverDownloadFellBack", { label: "oak-server.jar" })}`
              + `${error instanceof Error ? ` (${error.message})` : ""}`,
          });
        }
      }
    }
    if (!jarDelivered && files.jarBundledPath !== null) {
      await mustUpload("upload", files.jarBundledPath, jarRemotePath, jarUploadProgress);
      jarDelivered = true;
    }
    if (!jarDelivered && clientFileDownloader !== undefined) {
      emit({ stage: "upload", state: "log", detail: t("provisioning.detail.clientDownloadsJar") });
      const downloadedJarPath = await clientFileDownloader(serverJarUrl(files.kitVersion), "oak-server.jar",
        (bytesReceived, bytesTotal) => jarUploadProgress(bytesReceived, bytesTotal ?? bytesReceived));
      await mustUpload("upload", downloadedJarPath, jarRemotePath, jarUploadProgress);
      jarDelivered = true;
    }
    if (!jarDelivered) {
      throw new ProvisioningFailure("upload", t("provisioning.err.jarUnavailable"));
    }
    emit({
      stage: "upload",
      state: "done",
      detail: t("provisioning.detail.uploadedFiles"),
    });

    // ── env: per-deployment secrets (never on adopt) ────────────────────
    emit({ stage: "env", state: "start" });
    if (adopt) {
      emit({ stage: "env", state: "done", detail: t("provisioning.detail.envKept") });
    } else {
      const secrets = generateEnvSecrets(randomHex);
      // restoreMode arms the one-shot restore block in the file (the runner
      // reads OAK_RESTORE_FILE at boot and rewrites the advertised address to
      // OAK_RESTORE_PUBLIC_HOST — no REST token exists at that point).
      await mustWrite(
        "env",
        `${REMOTE_ROOT}/.env`,
        buildEnvFile(publicHost, params.host.trim(), secrets, restoreMode ? publicHost : null));
      emit({ stage: "env", state: "done", detail: t("provisioning.detail.envGenerated") });
    }

    // ── certificate: self-signed on a bare IP, ACME on a domain ─────────
    emit({ stage: "certificate", state: "start" });
    let certFingerprint: string | null = null;
    if (domainDeployment) {
      emit({
        stage: "certificate",
        state: "done",
        detail: t("provisioning.detail.certAcme", { host: publicHost }),
      });
    } else {
      const existingCert = await run("certificate", `test -f ${CERT_PATH} && echo yes || echo no`);
      const hasCert = existingCert.code === 0 && existingCert.stdout.trim() === "yes";
      if (adopt && hasCert) {
        // Regenerating would invalidate every client's pinned fingerprint —
        // an adopt run READS the certificate instead.
        const read = await must("certificate", `openssl x509 -in ${CERT_PATH} -noout -fingerprint -sha256`);
        certFingerprint = parseOpensslFingerprint(read.stdout);
        if (certFingerprint === null) {
          throw new ProvisioningFailure("certificate", t("provisioning.err.certRead"));
        }
        emit({ stage: "certificate", state: "done", detail: t("provisioning.detail.certKept") });
      } else {
        const san = selfSignedSan(params.host.trim());
        // Key generation goes through `openssl ecparam` — the one-shot
        // `req -newkey ec -pkeyopt ec_paramgen_curve:…` form is rejected by
        // some OpenSSL 3.0 builds ("Key parameter error", live VPS 2026-10-12),
        // while ecparam + req -new works from OpenSSL 1.0 through 3.x.
        await must(
          "certificate",
          `cd ${REMOTE_ROOT}/caddy && openssl ecparam -name prime256v1 -genkey -noout -out certs/tls.key `
            + `&& openssl req -x509 -new -key certs/tls.key -out certs/tls.crt -days 3650 `
            + `-subj '/CN=oak' -addext '${san}'`,
          { timeoutMs: OPENSSL_TIMEOUT_MS },
        );
        const read = await must("certificate", `openssl x509 -in ${CERT_PATH} -noout -fingerprint -sha256`);
        certFingerprint = parseOpensslFingerprint(read.stdout);
        if (certFingerprint === null) {
          throw new ProvisioningFailure("certificate", t("provisioning.err.certFingerprint"));
        }
        emit({ stage: "certificate", state: "done", detail: t("provisioning.detail.certSelfSigned", { fingerprint: certFingerprint.slice(0, 16) }) });
      }
    }

    // ── firewall: ufw with exactly the deployment's public ports ────────
    // The SSH port itself comes from the form: enabling ufw without allowing
    // the port the session rides on would lock the user out of the server.
    if (params.firewall) {
      emit({ stage: "firewall", state: "start" });
      await must(
        "firewall",
        "command -v ufw >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq ufw)",
        { timeoutMs: FIREWALL_INSTALL_TIMEOUT_MS },
      );
      await must(
        "firewall",
        `ufw allow ${params.sshPort}/tcp && ufw allow 443/tcp && ufw allow 9443/tcp`
          // 34780/udp is the PRIMARY TURN transport: a TURN Allocate travels
          // as UDP first (the server also advertises ?transport=tcp, but a
          // TCP relay's headroom is a poor voice path — UDP is the one that
          // must be open for 1-on-1 calls behind strict NAT).
          + " && ufw allow 34780/tcp && ufw allow 34780/udp && ufw allow 5349/tcp"
          + " && ufw allow 2000:2300/udp && ufw allow 55000:55050/udp"
          + " && ufw --force enable",
      );
      emit({ stage: "firewall", state: "done", detail: t("provisioning.detail.firewallDone") });
    }

    // ── small-host guard: RAM + swap headroom before lifting the stack ──
    // A 2 GB VPS OOM-killed the whole stack during the start (live
    // 2026-10-12): the kernel's OOM killer took janus and the sshd with it.
    // When RAM+swap sit under ~3 GB, a persistent 2 GB swapfile absorbs the
    // start spike; the fstab line makes it survive reboots. The check is on
    // SwapTotal (read in the probe stage above), NOT on the file's existence
    // (live 2026-10-13): the provider's image ships its own thin 512 MB
    // /swapfile — a "file exists → skip" guard left that sliver in place and
    // the stack OOM'd again, so a thin swap file is REBUILT to the full 2 GB.
    const MEMORY_FLOOR_KB = 3_000_000;
    const SWAP_TARGET_KB = 2_000_000;
    if (memoryNumbersKnown && memTotalKb + swapTotalKb < MEMORY_FLOOR_KB && swapTotalKb < SWAP_TARGET_KB) {
      emit({ stage: "compose", state: "log", detail: t("provisioning.detail.swapEnlarged") });
      await must(
        "compose",
        `swapoff /swapfile 2>/dev/null; rm -f /swapfile; `
          + `fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; `
          + `chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile `
          + `&& (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab)`,
        { timeoutMs: 180_000 },
      );
    }

    // ── compose: build the images and start the stack ───────────────────
    emit({ stage: "compose", state: "start", detail: t("provisioning.detail.composeStart") });
    // The image list: the bundled manifest's digest-pinned refs, or — for a
    // build without the bundled set — the image: lines of the compose file
    // itself. Every image pulls INDIVIDUALLY (user decision 2026-10-12): one
    // failing reference never aborts the others, so a partial mirror still
    // delivers everything it has.
    const bundledImages = files.images;
    const pullList = bundledImages !== null
      ? bundledImages.manifest.map((entry) => entry.ref)
      : composeImageRefs(files.composeFile);
    const missingCheck = `for IMAGE in ${pullList.map((ref) => `'${ref}'`).join(" ")}; do docker image inspect "$IMAGE" >/dev/null 2>&1 || echo "MISSING $IMAGE"; done`;
    let missingImages = parseMissingImages((await run("compose", missingCheck)).stdout);

    if (missingImages.length === 0) {
      emit({ stage: "compose", state: "log", detail: t("provisioning.detail.imagesInPlace") });
    } else {
      // A healthy host PULLS first (fast, with its own wide datacenter
      // channel) — the bundled archives only deploy as the RESCUE for what
      // no pull route could deliver, so normal networks never upload.
      let lastPullReason = "";
      const pullRound = async (refs: string[]): Promise<string[]> => {
        const stillMissing: string[] = [];
        for (const ref of refs) {
          const result = await run("compose", `docker pull '${ref}'`, { timeoutMs: SINGLE_PULL_TIMEOUT_MS });
          if (result.code !== 0) {
            stillMissing.push(ref);
            lastPullReason = describeExecFailure(result);
          }
        }
        if (stillMissing.length < refs.length) {
          emit({
            stage: "compose",
            state: "log",
            detail: t("provisioning.detail.imagesPulled", { done: refs.length - stillMissing.length, total: refs.length }),
          });
        }
        return stillMissing;
      };
      let remaining = await pullRound(missingImages);
      if (remaining.length > 0) {
        // Self-repair ladder — each step re-pulls ONLY what is still missing.
        const dnsCheck = await run("compose", "getent hosts registry-1.docker.io >/dev/null 2>&1 || echo NO_DNS");
        if (dnsCheck.code === 0 && dnsCheck.stdout.includes("NO_DNS")) {
          emit({ stage: "compose", state: "log", detail: t("provisioning.detail.dnsFix") });
          await run("compose", "sed -i '1i nameserver 1.1.1.1' /etc/resolv.conf");
          remaining = await pullRound(remaining);
        }
      }
      if (remaining.length > 0) {
        emit({ stage: "compose", state: "log", detail: t("provisioning.detail.mirrorsConfigured") });
        await must(
          "compose",
          `python3 -c 'import json, pathlib; target = pathlib.Path("/etc/docker/daemon.json"); `
            + `data = json.loads(target.read_text()) if target.exists() else {}; `
            // ORDER MATTERS: a mirror's denied/404 is AUTHORITATIVE for
            // dockerd — the next mirror never gets asked. gcr leads (it
            // serves the common images); daocloud denies anonymous pulls
            // from some networks and must not lead (live VPS 2026-10-12:
            // it blocked the pulls gcr would have served).
            + `data["registry-mirrors"] = ["https://mirror.gcr.io", "https://docker.m.daocloud.io"]; `
            + `target.write_text(json.dumps(data))'`,
          { timeoutMs: 30_000 },
        );
        // Restarting the daemon re-creates the running containers on an adopt
        // re-run (restart: unless-stopped) — a few seconds of downtime, no
        // data loss.
        await must("compose", "systemctl restart docker 2>/dev/null || service docker restart", { timeoutMs: 120_000 });
        remaining = await pullRound(remaining);
      }
      if (remaining.length > 0) {
        // A mirror answering "denied"/404 is AUTHORITATIVE for dockerd — it
        // never falls back to the Hub (daocloud denies anonymous pulls from
        // some networks, live VPS 2026-10-12). Last registry resort: strip
        // the mirrors and pull DIRECT — by now the original Hub-side trouble
        // (an anonymous per-IP rate limit, a 6-hour window) may have passed.
        emit({ stage: "compose", state: "log", detail: t("provisioning.detail.mirrorsRemoved") });
        await must(
          "compose",
          `python3 -c 'import json, pathlib; target = pathlib.Path("/etc/docker/daemon.json"); `
            + `data = json.loads(target.read_text()) if target.exists() else {}; `
            + `data.pop("registry-mirrors", None); `
            + `target.write_text(json.dumps(data))'`,
          { timeoutMs: 30_000 },
        );
        await must("compose", "systemctl restart docker 2>/dev/null || service docker restart", { timeoutMs: 120_000 });
        remaining = await pullRound(remaining);
      }
      if (remaining.length === 0) {
        emit({ stage: "compose", state: "log", detail: t("provisioning.detail.imagesFromRegistry") });
      } else if (files.imageManifest.length > 0) {
        // The GitHub leg (user decision 2026-11-02): the SERVER itself pulls
        // the missing tail from the oak-server release of the client's own
        // version tag — the client's home link stays out of the byte path
        // whenever the server can reach GitHub. Only the MISSING tail runs
        // here (the same re-count rule as every other leg).
        const missingEntries = files.imageManifest.filter((entry) => remaining.includes(entry.ref));
        const githubProbe = missingEntries.length > 0
          ? await probeServerUrl("compose", serverKitAssetUrl(files.kitVersion, missingEntries[0]!.archive))
          : { reachable: false } as const;
        if (githubProbe.reachable) {
          emit({
            stage: "compose",
            state: "log",
            detail: t("provisioning.detail.serverDownloadsImages", { count: missingEntries.length }),
          });
          await must("compose", `mkdir -p ${REMOTE_ROOT}/images`);
          const githubProgress = progressEmitter("compose");
          for (const entry of missingEntries) {
            try {
              await clearForeignPartial("compose", `${REMOTE_ROOT}/images/${entry.archive}`, entry.bytes);
              await downloadOnServer("compose", {
                url: serverKitAssetUrl(files.kitVersion, entry.archive),
                dest: `${REMOTE_ROOT}/images/${entry.archive}`,
                expectedBytes: entry.bytes,
                label: entry.archive,
                onProgress: (bytesReceived) => {
                  const text = formatByteProgress(bytesReceived, entry.bytes);
                  if (text.length > 0) {
                    githubProgress(`${entry.archive} ${text}`);
                  }
                },
              });
              await must("compose", `gunzip -c ${REMOTE_ROOT}/images/${entry.archive} | docker load`, { timeoutMs: IMAGE_LOAD_TIMEOUT_MS });
            } catch (error) {
              emit({
                stage: "compose",
                state: "log",
                detail: `${t("provisioning.detail.serverDownloadFellBack", { label: entry.archive })}`
                  + `${error instanceof Error ? ` (${error.message})` : ""}`,
              });
            }
          }
          remaining = parseMissingImages((await run("compose", missingCheck)).stdout);
          if (remaining.length === 0) {
            emit({ stage: "compose", state: "log", detail: t("provisioning.detail.imagesFromGithub") });
          }
        }
      }
      if (remaining.length > 0) {
        // The terminal stage (user decision 2026-11-02): whatever the registry
        // AND the server-side GitHub leg could not deliver travels through the
        // CLIENT — from the bundled archives when this build carries them
        // (files.images !== null: the full kit, dev tree with local tarballs),
        // or from a client-side GitHub download otherwise (the light kit; a
        // full build whose archives were cleaned away behaves like light, it
        // does NOT fail). Upload ONLY the missing tail; docker load imports.
        const useBundled = bundledImages !== null;
        if (useBundled) {
          emit({
            stage: "compose",
            state: "log",
            detail: t("provisioning.detail.bundleRescue", { count: remaining.length }),
          });
        } else if (clientFileDownloader !== undefined) {
          emit({
            stage: "compose",
            state: "log",
            detail: t("provisioning.detail.clientDownloadsImages", { count: remaining.length }),
          });
        } else {
          throw new ProvisioningFailure("compose", files.kit === "light"
            ? t("provisioning.err.imagesUnavailableLight", { list: remaining.join(", ") })
            : t("provisioning.err.imagesFailed", { reason: lastPullReason, list: remaining.join(", ") }));
        }
        await must("compose", `mkdir -p ${REMOTE_ROOT}/images`);
        const terminalProgress = progressEmitter("compose");
        for (const ref of remaining) {
          const entry = files.imageManifest.find((candidate) => candidate.ref === ref);
          if (entry === undefined) {
            continue; // not in the manifest either — the final check reports it
          }
          let localArchivePath: string;
          emit({
            stage: "compose",
            state: "log",
            detail: t("provisioning.detail.uploadingImage", { ref, mb: Math.round(entry.bytes / 1024 / 1024) }),
          });
          if (useBundled) {
            localArchivePath = `${bundledImages!.directory}/${entry.archive}`;
          } else {
            localArchivePath = await clientFileDownloader!(
              serverKitAssetUrl(files.kitVersion, entry.archive), entry.archive,
              (bytesReceived, bytesTotal) => {
                const text = formatByteProgress(bytesReceived, bytesTotal ?? entry.bytes);
                if (text.length > 0) {
                  terminalProgress(`${entry.archive} ${text}`);
                }
              },
            );
          }
          await mustUpload(
            "compose",
            localArchivePath,
            `${REMOTE_ROOT}/images/${entry.archive}`,
            (bytesSent, bytesTotal) => {
              const text = formatByteProgress(bytesSent, bytesTotal);
              if (text.length > 0) {
                terminalProgress(`${entry.archive} ${text}`);
              }
            },
          );
          await must("compose", `gunzip -c ${REMOTE_ROOT}/images/${entry.archive} | docker load`, { timeoutMs: IMAGE_LOAD_TIMEOUT_MS });
        }
        const recheck = parseMissingImages((await run("compose", missingCheck)).stdout);
        if (recheck.length > 0) {
          throw new ProvisioningFailure("compose", files.kit === "light"
            ? t("provisioning.err.imagesUnavailableLight", { list: recheck.join(", ") })
            : t("provisioning.err.imagesUnavailable", { list: recheck.join(", ") }));
        }
        emit({
          stage: "compose",
          state: "log",
          detail: useBundled
            ? t("provisioning.detail.bundleDeployed")
            : t("provisioning.detail.imagesViaClient"),
        });
      }
    }
    // SEQUENTIAL bring-up (user request 2026-10-12): lifting one service at a
    // time smooths the start spike on small hosts — a parallel `up` is what
    // OOM-killed the 2 GB VPS. The order front-loads the dependencies
    // (compose would raise them implicitly anyway); each `up` is idempotent,
    // so re-runs and partial stacks just continue where they stopped.
    const START_ORDER = restoreMode
      // Restore mode: oak starts in the RESTORE step, after the archive is in
      // place — its first boot is the one that loads the data.
      ? ["postgres", "minio", "minio-init", "janus", "coturn", "caddy"]
      : ["postgres", "minio", "minio-init", "janus", "coturn", "oak", "caddy"];
    // The per-service `up` prints one status line per container — surfacing it
    // shows the bring-up ORDER living ("Building oak…", "Started oak-janus").
    const composeLineProgress = progressEmitter("compose");
    const composeLine = (line: string): void => {
      const clipped = clipProgressLine(line);
      if (clipped.length > 0) {
        composeLineProgress(clipped);
      }
    };
    for (const service of START_ORDER) {
      await must("compose", `cd ${REMOTE_ROOT} && docker compose up -d --build ${service}`, {
        timeoutMs: COMPOSE_UP_TIMEOUT_MS,
        onOutputLine: composeLine,
      });
    }
    // Every rebuild with a CHANGED jar leaves the previous image dangling
    // (<none>, ~the jar layer each) — re-runs must not slowly fill the disk.
    // Only UNTAGGED images go; tagged ones in use are untouched, and the
    // build cache stays (it is what makes the next rebuild fast).
    await must("compose", "docker image prune -f");
    emit({ stage: "compose", state: "done", detail: t("provisioning.detail.containersUp") });

    // The readiness poll command (shared by the normal wait and the restore
    // leg — see the comment at the wait step below for the Host header and the
    // proxy-code exclusions).
    const pollCommand = `for attempt in $(seq 1 80); do `
      + `code=$(curl -sko /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${publicHost}" https://localhost/api/server 2>/dev/null); `
      + `if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "503" ] && [ "$code" != "504" ]; then echo "HTTP $code"; exit 0; fi; `
      + `sleep 5; done; echo 'the server did not answer within 400 seconds'; exit 1`;

    if (restoreMode) {
      // ── restore: deliver the archive, boot oak on it, watch the marker ──
      // oak was deliberately left out of START_ORDER: its FIRST boot is the
      // one that loads the data (RestoreRunner). The runner logs RESTORE
      // COMPLETED / RESTORE FAILED: … — a failed boot behind Caddy would
      // otherwise look like an eternal 502 wait-timeout with no cause.
      emit({ stage: "restore", state: "start", detail: t("provisioning.detail.restoreUploading") });
      await must("restore", `mkdir -p ${REMOTE_ROOT}/restore`);
      const restoreProgress = progressEmitter("restore");
      const backupRemotePath = `${REMOTE_ROOT}/restore/backup.zip`;
      if (migrationTransfer !== null) {
        // The DIRECT leg (2026-11-02): the new server pulls the archive from
        // the old one itself (curl + the one-shot token, ranged resume) — the
        // user's home link never joins the byte path. The token rides a 0600
        // file, never a command line (ps on the box would see it); the old
        // server's certificate (captured against the client's TOFU pin) rides
        // as the curl CA. Both files are scrubbed when the leg ends, any way.
        emit({ stage: "restore", state: "log", detail: t("provisioning.detail.restoreDirectPull") });
        const transferDir = `${REMOTE_ROOT}/transfer`;
        const authFile = `${transferDir}/.migration-auth`;
        const caFile = `${transferDir}/old-ca.pem`;
        await must("restore", `mkdir -p ${transferDir}`);
        await mustWrite("restore", authFile, `X-Space-Migration-Token: ${migrationTransfer.token}\n`, { mode: 0o600 });
        if (migrationTransfer.certificatePem !== null) {
          await mustWrite("restore", caFile, migrationTransfer.certificatePem, { mode: 0o600 });
        }
        try {
          await clearForeignPartial("restore", backupRemotePath, migrationTransfer.archiveBytes);
          await downloadOnServer("restore", {
            url: `${migrationTransfer.sourceUrl}/api/server/backup/transfer/file`,
            dest: backupRemotePath,
            expectedBytes: migrationTransfer.archiveBytes,
            label: "backup.zip",
            headerFile: authFile,
            cacertFile: migrationTransfer.certificatePem !== null ? caFile : undefined,
            onProgress: (bytesReceived) => {
              const text = formatByteProgress(bytesReceived, migrationTransfer.archiveBytes);
              if (text.length > 0) {
                restoreProgress(`backup.zip ${text}`);
              }
            },
          });
          // Transport integrity does not lean on TLS alone: the transferred
          // bytes must hash to the digest the issue response carried.
          await must("restore", `echo ${shellQuote(`${migrationTransfer.archiveSha256}  ${backupRemotePath}`)} | sha256sum -c -`);
        } finally {
          // The credential scrub (the .provision-* precedent): best-effort,
          // INSIDE the resume wrapper a failure here must not mask the leg's
          // own outcome.
          await run("restore", `rm -f ${authFile} ${caFile}`).catch(() => undefined);
        }
      } else {
        await mustUpload("restore", restoreArchivePath!, backupRemotePath, (bytesSent, bytesTotal) => {
          const text = formatByteProgress(bytesSent, bytesTotal);
          if (text.length > 0) {
            restoreProgress(`backup.zip ${text}`);
          }
        });
      }
      emit({ stage: "restore", state: "log", detail: t("provisioning.detail.restoreBooting") });
      await must("restore", `cd ${REMOTE_ROOT} && docker compose up -d --build oak`, {
        timeoutMs: COMPOSE_UP_TIMEOUT_MS,
        onOutputLine: composeLine,
      });
      emit({ stage: "restore", state: "log", detail: t("provisioning.detail.restoreWaiting") });
      const markerCommand = `for attempt in $(seq 1 90); do `
        + `LOG=$(docker logs --tail 300 oak-server 2>&1); `
        + `if echo "$LOG" | grep -q 'RESTORE FAILED'; then echo "$LOG" | grep 'RESTORE FAILED' | tail -1; exit 1; fi; `
        + `if echo "$LOG" | grep -q 'RESTORE COMPLETED'; then echo COMPLETED; exit 0; fi; `
        + `sleep 5; done; echo 'the restore marker did not appear within 450 seconds'; exit 1`;
      const markerResult = await run("restore", markerCommand, { timeoutMs: READINESS_TIMEOUT_MS });
      if (markerResult.code !== 0) {
        const reason = (markerResult.stdout.trim() || markerResult.stderr.trim()).split("\n").pop() ?? "";
        throw new ProvisioningFailure("restore", t("provisioning.err.restoreFailed", { reason }));
      }
      emit({ stage: "restore", state: "done", detail: t("provisioning.detail.restoreDone") });

      // oak is up and answering by now; the plain readiness poll still guards
      // the HTTPS entry before the user connects.
      emit({ stage: "wait", state: "start", detail: t("provisioning.detail.waitingServer") });
      const restorePoll = await must("wait", pollCommand, { timeoutMs: READINESS_TIMEOUT_MS });
      emit({ stage: "wait", state: "done", detail: t("provisioning.detail.serverAnswers", { code: restorePoll.stdout.trim() }) });
      // Accounts and passwords come from the archive; the owner's password is
      // known to the USER alone — the finish phase is needsLogin, no register.
      return { hostUrl, certFingerprint, ownerReady: false, adminUsername: params.adminLogin, restored: true };
    }

    // ── wait: the server answers over localhost HTTPS ────────────────────
    // The poll runs ON the server (curl -k against https://localhost with the
    // PUBLIC Host header): it measures the stack itself, immune to the
    // client's network path and the certificate trust not established yet.
    // The Host header is not cosmetic — Caddy routes by Host, and a bare
    // "localhost" matches NO site block: Caddy answers an EMPTY 200, which the
    // poll would mistake for readiness and register would read as "HTTP 200"
    // instead of 201/409 (live VPS 2026-10-13). The self-signed certificate's
    // SAN covers localhost, so the TLS handshake still succeeds.
    // The PROXY codes (502/503/504) are Caddy speaking while oak is still
    // booting — an answer from the proxy is NOT readiness (live VPS
    // 2026-10-13: the poll took a 502 for a ready server and register died
    // with "registration failed (HTTP 502)"); only the application's own
    // codes count.
    emit({ stage: "wait", state: "start", detail: t("provisioning.detail.waitingServer") });
    const pollResult = await must("wait", pollCommand, { timeoutMs: READINESS_TIMEOUT_MS });
    emit({ stage: "wait", state: "done", detail: t("provisioning.detail.serverAnswers", { code: pollResult.stdout.trim() }) });

    // ── register: the OWNER account + the advertised connection info ────
    // Bodies travel as FILES (writeFile), never on the command line — the
    // account password must not appear in any shell history or process list.
    emit({ stage: "register", state: "start", detail: t("provisioning.detail.creatingOwner") });
    const statusMarker = `-w '\\n__STATUS__%{http_code}'`;
    let ownerReady = false;

    const registerBody = JSON.stringify({
      username: params.adminLogin,
      password: params.adminPassword,
      // The nickname rides along when it differs from the login; the server
      // defaults a missing one to the login anyway.
      ...(params.adminNickname !== null && params.adminNickname !== params.adminLogin
        ? { nickname: params.adminNickname }
        : {}),
    });
    await mustWrite("register", `${REMOTE_ROOT}/.provision-register.json`, registerBody);
    const registerResponse = await must(
      "register",
      `curl -sk -X POST https://localhost/api/auth/register -H "Host: ${publicHost}" `
        + `-H 'Content-Type: application/json' -d @${REMOTE_ROOT}/.provision-register.json ${statusMarker}`,
    );
    const registerOutcome = parseCurlWithStatus(registerResponse.stdout);
    let accessToken: string | null = null;
    if (registerOutcome === null) {
      throw new ProvisioningFailure("register", t("provisioning.err.registerNoAnswer"));
    }
    /** Logs the typed credentials in and sets the token; a non-200 login is
     *  NOT fatal (a re-run's admin may carry a different password — the user
     *  then logs in manually; returns whether the automatic login worked). */
    const loginForToken = async (): Promise<boolean> => {
      const loginBody = JSON.stringify({ username: params.adminLogin, password: params.adminPassword });
      await mustWrite("register", `${REMOTE_ROOT}/.provision-login.json`, loginBody);
      const loginResponse = await must(
        "register",
        `curl -sk -X POST https://localhost/api/auth/login -H "Host: ${publicHost}" `
          + `-H 'Content-Type: application/json' -d @${REMOTE_ROOT}/.provision-login.json ${statusMarker}`,
      );
      const loginOutcome = parseCurlWithStatus(loginResponse.stdout);
      if (loginOutcome === null || loginOutcome.status !== 200) {
        return false;
      }
      accessToken = authResponseToken(extractJsonObject(loginOutcome.body));
      if (accessToken === null) {
        throw new ProvisioningFailure("register", t("provisioning.err.noToken"));
      }
      return true;
    };
    if (registerOutcome.status === 201) {
      emit({ stage: "register", state: "log", detail: t("provisioning.detail.accountRegistered", { login: params.adminLogin }) });
      // The wire register returns the CREATED USER (UserResponse — no token):
      // the access token only ever comes from login (AuthController).
      ownerReady = await loginForToken();
      if (!ownerReady) {
        throw new ProvisioningFailure("register", t("provisioning.err.loginAfterRegister"));
      }
    } else if (registerOutcome.status === 409) {
      // An adopt re-run: the account exists — log in with the typed password.
      ownerReady = await loginForToken();
      emit({
        stage: "register",
        state: "log",
        detail: ownerReady
          ? t("provisioning.detail.loggedInTyped")
          : t("provisioning.detail.loginMismatch"),
      });
    } else {
      const detail = serverErrorDetail(registerOutcome.body);
      throw new ProvisioningFailure(
        "register",
        t(detail !== null ? "provisioning.err.registerFailedDetail" : "provisioning.err.registerFailed", {
          status: registerOutcome.status,
          detail: detail ?? "",
        }),
      );
    }

    if (ownerReady && accessToken !== null) {
      // The advertised connection info drives invite links and the connect
      // hint (round B). The wire is UpdateConnectionInfoRequest —
      // connectionHost/connectionPort/connectionScheme, NOT host/scheme:
      // unknown fields are silently ignored and every DTO field then reads
      // as null, which the endpoint treats as "leave unchanged" — a 200 that
      // changes nothing (live VPS 2026-10-13). Port rides along so links do
      // not assemble as host:8080 under an https scheme.
      const connectionBody = JSON.stringify({
        connectionHost: publicHost,
        connectionPort: 443,
        connectionScheme: "https",
      });
      await mustWrite("register", `${REMOTE_ROOT}/.provision-connection.json`, connectionBody);
      const connectionResponse = await must(
        "register",
        `curl -sk -X PATCH https://localhost/api/server/connection -H "Host: ${publicHost}" `
          + `-H 'Content-Type: application/json' -H "Authorization: Bearer ${accessToken}" `
          + `-d @${REMOTE_ROOT}/.provision-connection.json ${statusMarker}`,
      );
      const connectionOutcome = parseCurlWithStatus(connectionResponse.stdout);
      if (connectionOutcome === null || connectionOutcome.status !== 200) {
        const status = connectionOutcome?.status ?? "no answer";
        throw new ProvisioningFailure("register", t("provisioning.err.addressFailed", { status: String(status) }));
      }
      emit({ stage: "register", state: "log", detail: t("provisioning.detail.addressSet", { host: publicHost }) });
    }
    await run("register", `rm -f ${REMOTE_ROOT}/.provision-register.json ${REMOTE_ROOT}/.provision-login.json ${REMOTE_ROOT}/.provision-connection.json`);
    emit({
      stage: "register",
      state: "done",
      detail: ownerReady
        ? t("provisioning.detail.serverReady")
        : t("provisioning.detail.serverReadyManual"),
    });

    return { hostUrl, certFingerprint, ownerReady, adminUsername: params.adminLogin, restored: false };
  } catch (error) {
    // A failed register step leaves the credential FILES behind (rm normally
    // runs on the success path) — best-effort scrub on EVERY failure; the
    // connection may already be gone, and then there is nothing to scrub
    // (a throw here must never REPLACE the failure being reported).
    await transport
      .exec(`rm -f ${REMOTE_ROOT}/.provision-register.json ${REMOTE_ROOT}/.provision-login.json ${REMOTE_ROOT}/.provision-connection.json`)
      .catch(() => undefined);
    if (error instanceof ProvisioningFailure) {
      emit({ stage: error.stage, state: "failed", detail: error.message });
    }
    throw error;
  }
}

/** The wire AuthResponse carries the access token as `token`. */
function authResponseToken(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const token = (body as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Spring's error body shape: {"error": …, "message": …} — message wins. */
function serverErrorDetail(body: string): string | null {
  const parsed = extractJsonObject(body);
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const message = (parsed as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
