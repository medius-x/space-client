/**
 * Main-process half of the provisioning flow (round C): the ssh2 transport
 * behind the pure pipeline (src/domain/provisioning/pipeline.ts), the file
 * templates read from electron/provisioning/files/, the jar resolution and
 * the IPC surface (`provisioning:start` / `provisioning:cancel` + the event
 * channel). Credentials live in this function's scope only — they are never
 * logged and never persisted.
 */
import { Client } from "ssh2";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { app, net } from "electron";
import {
  ConnectionLostError,
  runProvisioningPipeline,
  type ProvisioningFiles,
  type ProvisioningOutcome,
  type ProvisioningStage,
  type ProvisioningStepEvent,
  type ProvisioningTransport,
} from "../src/domain/provisioning/pipeline";
import { validateProvisioningParams, type ProvisioningParams } from "../src/domain/provisioning/params";
import { currentLang, tf, type MessageKey, type TranslateParams } from "../src/domain/i18n/i18n";

export type ProvisioningIpcEvent =
  | { kind: "step"; stage: ProvisioningStage | "connect" | "download"; state: "start" | "done" | "log" | "failed"; detail?: string; progress?: string }
  | { kind: "succeeded"; outcome: ProvisioningOutcome }
  | { kind: "failed"; stage: string; message: string };

export interface ProvisioningHooks {
  /** The single sink every event is forwarded to (the window's IPC channel). */
  sendEvent(event: ProvisioningIpcEvent): void;
  /** Called once on success — main registers the provisioned certificate's
   *  TOFU pin so the automatic login never trips the trust dialog. */
  onSucceeded(outcome: ProvisioningOutcome): void;
  /** File logging (secrets must never pass through here). */
  log(line: string): void;
}

/** The last-resort jar source: the latest GitHub release artifact (round D
 *  publishes it). The bundled jar next to the templates is the default. */
const PROVISIONING_JAR_URL = "https://github.com/medius-x/oak-server/releases/latest/download/oak-server.jar";
const JAR_DOWNLOAD_TIMEOUT_MS = 300_000;
/** No upload byte for this long = the link silently stopped delivering while
 *  ssh2 still considers the connection healthy (live 2026-10-28: a 79 MB jar
 *  upload froze mid-flight for good; the connection-level keepalive kept
 *  passing). Generous on purpose — crawling links move a 4 MB chunk in well
 *  under this. */
const UPLOAD_STALL_TIMEOUT_MS = 300_000;

// Dev (npm run dev AND the unpacked `npm start`): the templates live in the
// project tree next to this source file. Packaged: electron-builder's
// extraResources ships electron/provisioning/files under resources/provisioning/
// files (process.resourcesPath) — including the bundled server jar and the
// docker-image archives, which are too big for the asar and must stay plain
// files on disk for the SFTP streaming upload.
const TEMPLATE_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "provisioning", "files")
  : path.resolve(app.getAppPath(), "electron", "provisioning", "files");

function readTemplates(): Omit<ProvisioningFiles, "jarLocalPath"> {
  const read = (relativePath: string): string => {
    // Git's autocrlf may hand out CRLF on Windows; janus's libconfig parser
    // and the shell shebangs expect LF — normalize every text template.
    return fs.readFileSync(path.join(TEMPLATE_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
  };
  // The bundled image set (npm run images:sync): manifest.json + the archives.
  // A build without it simply ships no fallback — the pull ladder covers it.
  const imagesDirectory = path.join(TEMPLATE_ROOT, "images");
  const manifestPath = path.join(imagesDirectory, "manifest.json");
  let images: ProvisioningFiles["images"] = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed)) {
        // Entries whose archive is absent (a fresh clone has the manifest but
        // not the tarballs) drop out — those images fall back to the pull
        // ladder instead of failing the upload.
        const manifest = parsed.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const record = entry as { ref?: unknown; archive?: unknown; bytes?: unknown };
          return typeof record.ref === "string" && typeof record.archive === "string" && typeof record.bytes === "number"
            && fs.existsSync(path.join(imagesDirectory, record.archive))
            ? [{ ref: record.ref, archive: record.archive, bytes: record.bytes }]
            : [];
        });
        if (manifest.length > 0) {
          images = { manifest, directory: imagesDirectory };
        }
      }
    } catch (error) {
      appendTemplateLog(`image manifest unreadable (${error instanceof Error ? error.message : String(error)}) — bundled images disabled`);
    }
  }
  return {
    composeFile: read("docker-compose.yml"),
    dockerfileServer: read("Dockerfile.server"),
    janusDockerfile: read(path.join("janus", "Dockerfile")),
    janusConfig: read(path.join("janus", "janus.jcfg")),
    janusHttpConfig: read(path.join("janus", "janus.transport.http.jcfg")),
    caddyFileTemplate: read(path.join("caddy", "Caddyfile")),
    images,
  };
}

/** Non-fatal template warnings land in the log through the run's hooks. */
let templateWarningSink: ((line: string) => void) | null = null;
function appendTemplateLog(line: string): void {
  templateWarningSink?.(line);
}

// ---------------------------------------------------------------------------
// The ssh2 transport
// ---------------------------------------------------------------------------

/** The cancel path's own error: must NOT be classified as a connection loss —
 *  the resume ladder would flash "reconnecting" at a user who just asked to
 *  STOP (live 2026-10-28). */
class CancelledByUserError extends Error {
  constructor() {
    super("cancelled by the user");
  }
}

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
  /** The signal that killed the remote process, when it died to one (the
   *  OOM killer's SIGKILL carries no error line — live 2026-10-28); null for
   *  ordinary exits. */
  signal: string | null;
}

export class Ssh2Transport implements ProvisioningTransport {
  private connection = new Client();
  private connected = false;
  private connectParams: ProvisioningParams | null = null;
  /** Set by close() — the user cancelled (or the run ended); a resume must
   *  never reconnect against the user's will. */
  private closedByUser = false;
  /** In-flight operations, rejectable ON DEMAND: connection.end() only QUEUES
   *  a DISCONNECT — on a stalled or half-dead link the pending exec/SFTP
   *  promises would sit until TCP gives up (live 2026-10-28: the user
   *  hammered Cancel for a minute over a hung upload and nothing moved).
   *  close() rejects them all immediately. */
  private readonly pendingForceRejects = new Set<() => void>();

  static async connect(params: ProvisioningParams): Promise<Ssh2Transport> {
    const transport = new Ssh2Transport();
    await transport.openConnection(params);
    return transport;
  }

  /** Registers a rejector for force-cancellation; returns its unregister. */
  private registerForceReject(forceReject: () => void): () => void {
    this.pendingForceRejects.add(forceReject);
    return () => {
      this.pendingForceRejects.delete(forceReject);
    };
  }

  private openConnection(params: ProvisioningParams): Promise<void> {
    this.connectParams = params;
    return new Promise((resolve, reject) => {
      const onFailure = (error: Error): void => {
        this.connected = false;
        reject(new Error(`SSH connection failed: ${error.message}`));
      };
      this.connection.once("ready", () => {
        this.connected = true;
        resolve();
      });
      this.connection.once("error", onFailure);
      // A dropped link fires 'close' with no error — the connected flag must
      // die with it, or a later exec would hang on a dead socket.
      this.connection.once("close", () => {
        this.connected = false;
        this.sftpHandle = null;
      });
      const connectOptions: Record<string, unknown> = {
        host: params.host.trim(),
        port: params.sshPort,
        username: params.sshLogin.trim(),
        // A PATIENT keepalive (live 2026-10-28): the stock 3×15 s tolerance
        // tore the connection down while the server was merely quiet under a
        // heavy package unpack. 10 misses give a loaded box 150 s of grace;
        // a genuinely dead link still fails within the step's own timeout.
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 10,
      };
      if (params.sshPassword !== null && params.sshPassword.length > 0) {
        connectOptions.password = params.sshPassword;
      }
      if (params.sshKeyPath !== null && params.sshKeyPath.trim().length > 0) {
        connectOptions.privateKey = fs.readFileSync(params.sshKeyPath.trim());
        if (params.sshKeyPassphrase !== null && params.sshKeyPassphrase.length > 0) {
          connectOptions.passphrase = params.sshKeyPassphrase;
        }
      }
      this.connection.connect(connectOptions);
    });
  }

  async exec(
    command: string,
    options?: { timeoutMs?: number; onOutputLine?: (line: string) => void },
  ): Promise<ExecOutcome> {
    if (!this.connected) {
      throw new ConnectionLostError("connection closed before the command started");
    }
    // Line reassembly for the live progress: apt/docker/compose emit complete
    // lines; a trailing partial chunk stays buffered until its newline, and a
    // \r-redrawn progress bar flushes the visible line on every carriage
    // return.
    const lineSink = options?.onOutputLine ?? null;
    let lineBuffer = "";
    const feedLines = (text: string): void => {
      if (lineSink === null) {
        return;
      }
      lineBuffer += text;
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        lineSink(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf("\n");
      }
      const carriageIndex = lineBuffer.lastIndexOf("\r");
      if (carriageIndex >= 0) {
        lineSink(lineBuffer.slice(0, carriageIndex));
        lineBuffer = lineBuffer.slice(carriageIndex + 1);
      }
    };
    let unregisterForceReject: () => void = () => undefined;
    const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
      unregisterForceReject = this.registerForceReject(() => reject(new Error("cancelled by the user")));
      this.connection.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        // ssh2 reports a signalled death as exit(null, signal, …) — remember
        // it, so the failure reason can NAME the killer class (a killed apt
        // prints no error line of its own; live 2026-10-28).
        let killedBySignal: string | null = null;
        stream.on("exit", (code: number | null, signal?: string) => {
          if (code === null && typeof signal === "string" && signal.length > 0) {
            killedBySignal = signal;
          }
        });
        stream.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          feedLines(text);
          // Long-running steps must not buffer unbounded output.
          if (stdout.length > 4_000_000) {
            stdout = stdout.slice(-2_000_000);
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          feedLines(text);
          if (stderr.length > 1_000_000) {
            stderr = stderr.slice(-500_000);
          }
        });
        stream.on("close", (code: number | null) => {
          if (code === null && killedBySignal === null) {
            // No exit status and no signal: the CHANNEL died with the
            // connection, the command's fate is unknown. The live incident
            // (2026-10-28): apt kept running server-side and finished fine —
            // the pipeline resumes such commands on a fresh channel.
            reject(new ConnectionLostError());
            return;
          }
          resolve({ code: code ?? -1, signal: killedBySignal, stdout, stderr });
        });
        const timeout = options?.timeoutMs;
        if (timeout !== undefined) {
          const timer = setTimeout(() => {
            stream.close();
            reject(new Error(`command timed out after ${Math.round(timeout / 1000)} s`));
          }, timeout);
          stream.once("close", () => clearTimeout(timer));
        }
      });
    }).catch((error: unknown) => {
      // A cancelled run closes the connection — surface it as a plain failure.
      throw error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
      unregisterForceReject();
    });
    return outcome;
  }

  async writeFile(remotePath: string, contents: string | Uint8Array): Promise<void> {
    if (!this.connected) {
      throw new ConnectionLostError("connection closed before the write started");
    }
    const sftp = await this.openSftp();
    let unregisterForceReject: () => void = () => undefined;
    await new Promise<void>((resolve, reject) => {
      unregisterForceReject = this.registerForceReject(() => reject(new CancelledByUserError()));
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on("close", () => resolve());
      writeStream.on("error", reject);
      writeStream.end(contents);
    }).catch((error: unknown) => {
      throw this.toConnectionLoss(error);
    }).finally(() => {
      unregisterForceReject();
    });
  }

  async readFile(remotePath: string): Promise<string | null> {
    if (!this.connected) {
      throw new ConnectionLostError("connection closed before the read started");
    }
    const sftp = await this.openSftp();
    let unregisterForceReject: () => void = () => undefined;
    const contents = await new Promise<string | null>((resolve, reject) => {
      unregisterForceReject = this.registerForceReject(() => reject(new CancelledByUserError()));
      let data = "";
      const readStream = sftp.createReadStream(remotePath, { encoding: "utf8" });
      readStream.on("data", (chunk: string) => {
        data += chunk;
      });
      readStream.on("end", () => resolve(data));
      readStream.on("error", () => {
        // A missing file and a dead connection are different failures: only
        // the latter must reach the resume ladder (a null means "no compose
        // file" to the adopt check — silence here would flip adopt to fresh).
        if (!this.connected) {
          reject(new ConnectionLostError());
        } else {
          resolve(null);
        }
      });
    }).finally(() => {
      unregisterForceReject();
    });
    return contents;
  }

  async writeLocalFile(
    localPath: string,
    remotePath: string,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
  ): Promise<void> {
    if (!this.connected) {
      throw new ConnectionLostError("connection closed before the upload started");
    }
    const sftp = await this.openSftp();
    const bytesTotal = fs.statSync(localPath).size;
    let unregisterForceReject: () => void = () => undefined;
    await new Promise<void>((resolve, reject) => {
      // LARGE chunks on both ends: Node's default 64 KB read chunks serialize
      // against the SFTP backpressure one round-trip at a time — on a ~200 ms
      // HK link that throttled image uploads to a crawl while the in-memory
      // writeFile path (the jar) flew (live report 2026-10-12). 4 MB chunks
      // let ssh2 pipeline its writes and fill the channel.
      const writeStream = sftp.createWriteStream(remotePath, { highWaterMark: 4 * 1024 * 1024 });
      // STALL WATCHDOG (live 2026-10-28): the link can silently stop
      // delivering while ssh2 still considers the connection healthy — the
      // upload then hangs forever (no error, no close, keepalives passing).
      // No byte for UPLOAD_STALL_TIMEOUT → reject as a connection loss; the
      // pipeline's resume ladder reconnects and restarts the file from zero.
      let stallTimer: NodeJS.Timeout | null = null;
      const clearStallTimer = (): void => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };
      const armStallTimer = (): void => {
        clearStallTimer();
        stallTimer = setTimeout(() => {
          readStream.destroy();
          reject(new ConnectionLostError(
            `the upload of ${remotePath} stalled — no bytes delivered for ${Math.round(UPLOAD_STALL_TIMEOUT_MS / 1000)} s`));
        }, UPLOAD_STALL_TIMEOUT_MS);
      };
      writeStream.on("close", () => {
        clearStallTimer();
        resolve();
      });
      writeStream.on("error", (error: Error) => {
        clearStallTimer();
        reject(error);
      });
      let bytesSent = 0;
      const readStream = fs.createReadStream(localPath, { highWaterMark: 4 * 1024 * 1024 });
      unregisterForceReject = this.registerForceReject(() => {
        clearStallTimer();
        readStream.destroy();
        reject(new CancelledByUserError());
      });
      // The REAL delivery pace: pipe backpressure pauses the disk reads to the
      // network's tempo, so counting read chunks tracks the wire (within one
      // chunk) instead of racing ahead of it.
      readStream.on("data", (chunk: string | Buffer) => {
        // No encoding is set, so chunks are Buffers in practice; the union is
        // the stream typings' default.
        bytesSent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        onProgress?.(bytesSent, bytesTotal);
        armStallTimer();
      });
      readStream.on("error", (error) => {
        clearStallTimer();
        reject(error);
      });
      readStream.pipe(writeStream);
      armStallTimer();
    }).catch((error: unknown) => {
      throw this.toConnectionLoss(error);
    }).finally(() => {
      unregisterForceReject();
    });
  }

  /** Re-establishes the connection with the SAME credentials after a drop.
   *  False when the run was cancelled (close() — a resume must not fight the
   *  user) or the server is unreachable; the ladder's budget does the rest. */
  async reconnect(): Promise<boolean> {
    if (this.closedByUser || this.connectParams === null) {
      return false;
    }
    try {
      this.connection.end();
    } catch {
      // already dead — the point is a FRESH client below
    }
    this.connected = false;
    this.sftpHandle = null;
    this.connection = new Client();
    try {
      await this.openConnection(this.connectParams);
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** ssh2 surfaces a connection death inside SFTP streams as a generic stream
   *  error — reclassify it when the connection is gone so the pipeline's
   *  resume ladder sees ConnectionLostError instead of failing the run. The
   *  user's cancel keeps its own class: the ladder must not try to resume. */
  private toConnectionLoss(error: unknown): unknown {
    if (this.connected || error instanceof CancelledByUserError) {
      return error;
    }
    return new ConnectionLostError(error instanceof Error ? error.message : undefined);
  }

  private sftpHandle: import("ssh2").SFTPWrapper | null = null;

  private async openSftp(): Promise<import("ssh2").SFTPWrapper> {
    if (this.sftpHandle !== null) {
      return this.sftpHandle;
    }
    this.sftpHandle = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
      this.connection.sftp((error, sftp) => {
        if (error) {
          reject(error);
        } else {
          resolve(sftp);
        }
      });
    });
    return this.sftpHandle;
  }

  close(): void {
    this.closedByUser = true;
    this.connected = false;
    this.sftpHandle = null;
    this.connection.end();
    // end() only QUEUES a DISCONNECT — on a stalled or half-dead link the
    // in-flight operations would sit until TCP gives up on its retries
    // (live 2026-10-28: a hung 79 MB upload ignored a minute of Cancel
    // clicks). Reject every pending operation NOW.
    const forceRejects = [...this.pendingForceRejects];
    this.pendingForceRejects.clear();
    for (const forceReject of forceRejects) {
      forceReject();
    }
  }
}

// ---------------------------------------------------------------------------
// The run + IPC registration
// ---------------------------------------------------------------------------

let activeRun: { transport: Ssh2Transport } | null = null;

/** A resolved jar source: the LOCAL path to upload from + a cleanup for the
 *  downloaded-to-temp variant. Every large file (jar, image archives) uploads
 *  through the SAME streaming writeLocalFile path — identical speed and
 *  behaviour by construction. */
interface JarSource {
  localPath: string;
  cleanup: (() => void) | null;
}

/**
 * The jar source ladder (user decision, 2026-10-12): a local path from the
 * Advanced section ALWAYS wins; otherwise the jar BUNDLED with this client
 * build (the version guarantee — the client deploys the server it was built
 * against); a GitHub release download remains the last-resort fallback for
 * builds packaged without the jar.
 */
async function resolveJarSource(jarPath: string | null, emit: (event: ProvisioningIpcEvent) => void): Promise<JarSource> {
  if (jarPath !== null && jarPath.trim().length > 0) {
    const localPath = jarPath.trim();
    emit({ kind: "step", stage: "download", state: "done", detail: `server jar read from ${path.basename(localPath)}` });
    return { localPath, cleanup: null };
  }
  const bundledJarPath = path.join(TEMPLATE_ROOT, "oak-server.jar");
  if (fs.existsSync(bundledJarPath)) {
    const megabytes = Math.round(fs.statSync(bundledJarPath).size / 1024 / 1024);
    emit({
      kind: "step",
      stage: "download",
      state: "done",
      detail: `using the bundled server jar (${megabytes} MB)`,
    });
    return { localPath: bundledJarPath, cleanup: null };
  }
  emit({ kind: "step", stage: "download", state: "start", detail: "no bundled jar — downloading the latest server release from GitHub" });
  const response = await net.fetch(PROVISIONING_JAR_URL, { signal: AbortSignal.timeout(JAR_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `the latest release jar is not available (HTTP ${response.status}) — pick a local oak-server.jar in Advanced`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tempPath = path.join(app.getPath("temp"), `space-provisioning-jar-${Date.now()}.jar`);
  await fs.promises.writeFile(tempPath, bytes);
  emit({ kind: "step", stage: "download", state: "done", detail: `server jar downloaded (${Math.round(bytes.byteLength / 1024 / 1024)} MB)` });
  return { localPath: tempPath, cleanup: () => void fs.promises.unlink(tempPath).catch(() => undefined) };
}

/** The migrate flow's one-shot archive (user decision 2026-10-28): deleted when
 *  the run ends ANY way — success, failure, user cancel. The path is only ever
 *  touched when it lies INSIDE the migration temp dir: the Create flow's
 *  user-picked archive must never be removed by a run. */
function deleteMigrationArchive(params: ProvisioningParams, log: (line: string) => void): void {
  if (params.migrationArchive !== true || params.backupArchivePath === null) {
    return;
  }
  const resolved = path.resolve(params.backupArchivePath.trim());
  const migrateDir = path.resolve(path.join(app.getPath("temp"), "space-migrate"));
  const relative = path.relative(migrateDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  fs.promises.unlink(resolved)
    .then(() => log(`migration archive removed: ${path.basename(resolved)}`))
    .catch((error: unknown) => log(`could not remove the migration archive: ${error instanceof Error ? error.message : String(error)}`));
}

/** Starts the run; every outcome travels through hooks.sendEvent. */
export async function startProvisioningRun(params: ProvisioningParams, hooks: ProvisioningHooks): Promise<boolean> {
  if (activeRun !== null) {
    hooks.sendEvent({ kind: "failed", stage: "connect", message: "a provisioning run is already in progress" });
    return false;
  }
  // Defense in depth: the renderer validates too, but the shell-facing values
  // are re-checked on THIS side of the IPC boundary.
  const validation = validateProvisioningParams(params);
  if (validation !== null) {
    hooks.sendEvent({ kind: "failed", stage: "connect", message: validation });
    return false;
  }
  // The optional restore archive must exist BEFORE the run starts (backup
  // round 2026-10-28) — failing 15 minutes into a deployment over a typo'd
  // path is the worst possible place to discover it.
  if (params.backupArchivePath !== null && params.backupArchivePath.trim().length > 0) {
    if (!fs.existsSync(params.backupArchivePath.trim()) || !fs.statSync(params.backupArchivePath.trim()).isFile()) {
      hooks.sendEvent({ kind: "failed", stage: "connect", message: `backup archive not found: ${params.backupArchivePath.trim()}` });
      return false;
    }
  }

  const emit = (event: ProvisioningIpcEvent): void => {
    hooks.sendEvent(event);
    // Every step lands in space.log too (user report 2026-10-12: an OOM
    // during the run killed the window, and the UI-only steps were lost — the
    // file log only carried the final verdict, nothing to diagnose from).
    if (event.kind === "step") {
      hooks.log(`[provisioning] ${event.stage} ${event.state}${event.detail !== undefined ? `: ${event.detail}` : ""}`);
    }
  };
  const stepEmit = (event: ProvisioningStepEvent): void => {
    lastStage = event.stage;
    emit({ kind: "step", ...event });
  };

  let transport: Ssh2Transport | null = null;
  let jarCleanup: (() => void) | null = null;
  // The last stage the pipeline touched — a cancel/failure surfacing without
  // its own stage (transport-level errors) is reported against THE step the
  // user was watching, not a phantom "connect".
  let lastStage = "connect";
  cancellationRequested = false;
  activeRun = { transport: null as unknown as Ssh2Transport };
  try {
    emit({ kind: "step", stage: "download", state: "start", detail: "resolving the server jar" });
    const jarSource = await resolveJarSource(params.jarPath, emit);
    jarCleanup = jarSource.cleanup;
    if (cancellationRequested) {
      throw new Error("cancelled by the user");
    }

    emit({ kind: "step", stage: "connect", state: "start", detail: `connecting to ${params.host.trim()} as ${params.sshLogin.trim()}` });
    transport = await Ssh2Transport.connect(params);
    if (cancellationRequested) {
      throw new Error("cancelled by the user");
    }
    activeRun.transport = transport;
    emit({ kind: "step", stage: "connect", state: "done" });

    templateWarningSink = hooks.log;
    const files: ProvisioningFiles = { ...readTemplates(), jarLocalPath: jarSource.localPath };
    // The step-detail translator reads the CURRENT main-process language, so a
    // language flip mid-run recolors the steps that have not fired yet.
    const translate = (key: MessageKey, translateParams?: TranslateParams): string => tf(currentLang(), key, translateParams);
    const outcome = await runProvisioningPipeline(transport, params, files, stepEmit, (bytes) =>
      crypto.randomBytes(bytes).toString("hex"), translate,
    );
    hooks.onSucceeded(outcome);
    emit({ kind: "succeeded", outcome });
    hooks.log(`[provisioning] deployment ready at ${outcome.hostUrl}`);
    return true;
  } catch (error) {
    // A cancelled run reports CANCELLATION, whatever the transport error
    // underneath (the force-reject may surface as a stall or a connection
    // loss — the user asked to stop, not to hear about the network).
    const message = cancellationRequested ? "cancelled by the user" : error instanceof Error ? error.message : String(error);
    const stage = error instanceof Error && "stage" in error ? String((error as { stage: unknown }).stage) : lastStage;
    emit({ kind: "failed", stage, message });
    hooks.log(`[provisioning] FAILED (${stage}): ${message}`);
    return false;
  } finally {
    jarCleanup?.();
    transport?.close();
    deleteMigrationArchive(params, hooks.log);
    activeRun = null;
    cancellationRequested = false;
  }
}

/** Cancels the run: drops the SSH connection if it is up (the in-flight step
 *  fails), and arms the flag for the pre-connect phases — the jar download
 *  and the connection itself check it and stop instead of continuing. */
let cancellationRequested = false;

export function cancelProvisioningRun(): void {
  cancellationRequested = true;
  activeRun?.transport?.close();
}
