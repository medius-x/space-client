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
import { app, net, session as electronSession } from "electron";
import {
  ConnectionLostError,
  runProvisioningPipeline,
  type ClientFileDownloader,
  type ProvisioningFiles,
  type ProvisioningOutcome,
  type ProvisioningStage,
  type ProvisioningStepEvent,
  type ProvisioningTransport,
} from "../src/domain/provisioning/pipeline";
import { validateProvisioningParams, type ProvisioningParams } from "../src/domain/provisioning/params";
import { parseImageManifest, parseKitMarker } from "../src/domain/provisioning/artifacts";
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

/** The last-resort jar source: the GitHub release artifact of the tag matching
 *  THIS client's version (parity beats availability — "latest" could hand out
 *  a server the client was not built against). The bundled jar next to the
 *  templates is the default. */
/** No upload byte for this long = the link silently stopped delivering while
 *  ssh2 still considers the connection healthy (live 2026-10-28: a 79 MB jar
 *  upload froze mid-flight for good; the connection-level keepalive kept
 *  passing). Generous on purpose — crawling links move a 4 MB chunk in well
 *  under this. */
const UPLOAD_STALL_TIMEOUT_MS = 300_000;
/** The download twin of the upload watchdog: no body byte for this long = the
 *  fetch is dead in the water (a stalled response body never errors on its
 *  own). Deliberately NO overall AbortSignal cap — a crawling link may take
 *  half an hour for a 190 MB archive and still be making progress. */
const DOWNLOAD_STALL_TIMEOUT_MS = 300_000;
/** IPC progress is throttled by time, not bytes: a fast link pumps megabytes
 *  per read and must not flood the renderer with one event per chunk. */
const DOWNLOAD_PROGRESS_MIN_INTERVAL_MS = 250;

// Dev (npm run dev AND the unpacked `npm start`): the templates live in the
// project tree next to this source file. Packaged: electron-builder's
// extraResources ships electron/provisioning/files under resources/provisioning/
// files (process.resourcesPath) — including the bundled server jar and the
// docker-image archives, which are too big for the asar and must stay plain
// files on disk for the SFTP streaming upload.
const TEMPLATE_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "provisioning", "files")
  : path.resolve(app.getAppPath(), "electron", "provisioning", "files");

function readTemplates(): Omit<ProvisioningFiles, "jarOverridePath" | "jarBundledPath" | "kitVersion"> {
  const read = (relativePath: string): string => {
    // Git's autocrlf may hand out CRLF on Windows; janus's libconfig parser
    // and the shell shebangs expect LF — normalize every text template.
    return fs.readFileSync(path.join(TEMPLATE_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
  };
  const readOrNull = (relativePath: string): string | null => {
    const filePath = path.join(TEMPLATE_ROOT, relativePath);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  };
  // The kit marker (light/full — user decision 2026-10-29): the FULL bundle
  // ships the server kit in extraResources, the LIGHT one ships only the
  // templates + manifest. Pre-0.4.0 installs and dev trees carry no marker —
  // they keep the historical "full" reading.
  const kit = parseKitMarker(readOrNull("kit.json"));
  // The manifest is the ALWAYS-present pin source for both kits. The ARCHIVES
  // are the full kit's own: entries whose archive is absent (a light build, a
  // fresh clone) drop out of the bundled set — the ladder then covers those
  // images from the registry/GitHub instead of failing the upload.
  const manifestContent = readOrNull(path.join("images", "manifest.json"));
  const imageManifest = parseImageManifest(manifestContent) ?? [];
  if (manifestContent !== null && imageManifest.length === 0) {
    appendTemplateLog("image manifest unreadable — digest pins disabled, the pull ladder falls back to compose refs");
  }
  const imagesDirectory = path.join(TEMPLATE_ROOT, "images");
  const archived = imageManifest.filter((entry) => fs.existsSync(path.join(imagesDirectory, entry.archive)));
  const images: ProvisioningFiles["images"] = archived.length > 0 ? { manifest: archived, directory: imagesDirectory } : null;
  return {
    composeFile: read("docker-compose.yml"),
    dockerfileServer: read("Dockerfile.server"),
    janusDockerfile: read(path.join("janus", "Dockerfile")),
    janusConfig: read(path.join("janus", "janus.jcfg")),
    janusHttpConfig: read(path.join("janus", "janus.transport.http.jcfg")),
    caddyFileTemplate: read(path.join("caddy", "Caddyfile")),
    kit,
    imageManifest,
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

  async writeFile(remotePath: string, contents: string | Uint8Array, options?: { mode?: number }): Promise<void> {
    if (!this.connected) {
      throw new ConnectionLostError("connection closed before the write started");
    }
    const sftp = await this.openSftp();
    let unregisterForceReject: () => void = () => undefined;
    await new Promise<void>((resolve, reject) => {
      unregisterForceReject = this.registerForceReject(() => reject(new CancelledByUserError()));
      // The mode matters for the migration leg's credential files: a token file
      // must be 0600 — world-readable would hand the one-shot archive key to
      // any local user of the fresh box.
      const writeStream = options?.mode !== undefined
        ? sftp.createWriteStream(remotePath, { mode: options.mode })
        : sftp.createWriteStream(remotePath);
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

/**
 * Streams a large HTTP body straight to disk — the jar and (light kit) the
 * image archives must NEVER buffer through arrayBuffer in memory (79–190 MB is
 * swap roulette). Precedent: the backup downloader's reader→writeStream loop
 * (electron/backups.ts). A stall watchdog replaces any overall deadline: a
 * crawling link may legitimately take half an hour for a big archive, but a
 * link that stops delivering bytes entirely is dead. A failed or aborted
 * download removes the partial file — a half-written archive must never look
 * like a usable source. Returns the number of bytes written.
 */
async function downloadToFile(
  sourceUrl: string,
  destinationPath: string,
  onProgress: (bytesReceived: number, bytesTotal: number | null) => void,
  shouldAbort?: () => boolean,
): Promise<number> {
  const response = await net.fetch(sourceUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (HTTP ${response.status})`);
  }
  const bytesTotal = response.headers.has("content-length") ? Number(response.headers.get("content-length")) : null;
  const reader = response.body.getReader();
  const writeStream = fs.createWriteStream(destinationPath);
  let writeStreamError: Error | null = null;
  writeStream.on("error", (error: Error) => {
    writeStreamError = error;
  });
  let stallTimer: NodeJS.Timeout | null = null;
  let stalledByWatchdog = false;
  const clearStallTimer = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  let bytesReceived = 0;
  let lastProgressAt = 0;
  try {
    for (;;) {
      if (shouldAbort?.() === true) {
        throw new Error("cancelled by the user");
      }
      // Re-arm on every iteration: "progress" means bytes keep arriving,
      // however slowly — the watchdog must not punish a merely slow link.
      stallTimer = setTimeout(() => {
        // Cancel unblocks the pending read() (it then reports done) — the
        // flag above tells the loop this was a stall, not an end of body.
        stalledByWatchdog = true;
        void reader.cancel().catch(() => undefined);
      }, DOWNLOAD_STALL_TIMEOUT_MS);
      const chunk = await reader.read();
      clearStallTimer();
      if (stalledByWatchdog) {
        throw new Error(
          `the download of ${path.basename(destinationPath)} stalled — no bytes for ${Math.round(DOWNLOAD_STALL_TIMEOUT_MS / 1000)} s`);
      }
      if (chunk.done) {
        break;
      }
      bytesReceived += chunk.value.byteLength;
      const now = Date.now();
      if (now - lastProgressAt >= DOWNLOAD_PROGRESS_MIN_INTERVAL_MS) {
        lastProgressAt = now;
        onProgress(bytesReceived, bytesTotal);
      }
      // Await the write: disk backpressure paces the reads honestly.
      await new Promise<void>((resolveWrite, rejectWrite) => {
        writeStream.write(chunk.value, (error) => (error === undefined ? resolveWrite() : rejectWrite(error)));
      });
    }
    // Drain fully — resolve only after every buffered byte hit the disk.
    await new Promise<void>((resolveClose) => {
      writeStream.once("close", resolveClose);
      writeStream.end();
    });
    if (writeStreamError !== null) {
      throw writeStreamError;
    }
    return bytesReceived;
  } catch (error) {
    clearStallTimer();
    writeStream.destroy();
    await reader.cancel().catch(() => undefined);
    await fs.promises.unlink(destinationPath).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
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
  // The light kit's client-side downloads (jar / image archives fetched to
  // temp when the server cannot reach GitHub) — removed on EVERY exit.
  const downloadedKitFiles: string[] = [];
  // The last stage the pipeline touched — a cancel/failure surfacing without
  // its own stage (transport-level errors) is reported against THE step the
  // user was watching, not a phantom "connect".
  let lastStage = "connect";
  cancellationRequested = false;
  activeRun = { transport: null as unknown as Ssh2Transport };
  try {
    emit({ kind: "step", stage: "connect", state: "start", detail: `connecting to ${params.host.trim()} as ${params.sshLogin.trim()}` });
    transport = await Ssh2Transport.connect(params);
    if (cancellationRequested) {
      throw new Error("cancelled by the user");
    }
    activeRun.transport = transport;
    emit({ kind: "step", stage: "connect", state: "done" });

    templateWarningSink = hooks.log;
    // The jar sources (the ladder lives in the pipeline): an Advanced-section
    // override ALWAYS wins; otherwise the bundled jar (full kit) is the local
    // fallback while the SERVER-side GitHub download is tried first.
    const jarOverridePath = params.jarPath !== null && params.jarPath.trim().length > 0 ? params.jarPath.trim() : null;
    const bundledJarPath = path.join(TEMPLATE_ROOT, "oak-server.jar");
    const files: ProvisioningFiles = {
      ...readTemplates(),
      jarOverridePath,
      jarBundledPath: fs.existsSync(bundledJarPath) ? bundledJarPath : null,
      kitVersion: app.getVersion(),
    };
    // The client-side leg of the big-content ladder: fetches a kit asset to a
    // local temp file (streamed, stall-watched, cancellable) and hands the
    // path back for the SFTP upload. Only ever used when the server itself
    // cannot reach GitHub — the home link joins the byte path last.
    const clientFileDownloader: ClientFileDownloader = async (url, fileName, onProgress) => {
      const tempPath = path.join(app.getPath("temp"), `space-provisioning-kit-${Date.now()}-${fileName}`);
      downloadedKitFiles.push(tempPath);
      await downloadToFile(url, tempPath, onProgress, () => cancellationRequested);
      return tempPath;
    };
    // The step-detail translator reads the CURRENT main-process language, so a
    // language flip mid-run recolors the steps that have not fired yet.
    const translate = (key: MessageKey, translateParams?: TranslateParams): string => tf(currentLang(), key, translateParams);
    const outcome = await runProvisioningPipeline(transport, params, files, stepEmit, (bytes) =>
      crypto.randomBytes(bytes).toString("hex"), translate, undefined, clientFileDownloader,
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
    for (const tempPath of downloadedKitFiles) {
      void fs.promises.unlink(tempPath).catch(() => undefined);
    }
    transport?.close();
    deleteMigrationArchive(params, hooks.log);
    activeRun = null;
    cancellationRequested = false;
  }
}

/** Cancels the run: drops the SSH connection if it is up (the in-flight step
 *  fails), and arms the flag for the pre-connect phases — the jar download
 *  and the connection itself check it and stop instead of continuing. The
 *  detached server-side downloads are killed by their marker first (their
 *  stdio is off the channel, so the connection drop alone would leave them
 *  running). */
let cancellationRequested = false;

export async function cancelProvisioningRun(): Promise<void> {
  cancellationRequested = true;
  const transport = activeRun?.transport;
  if (transport != null) {
    try {
      // Best-effort, bounded: the transport is about to close anyway.
      await transport.exec("pkill -f space-provisioning-download || true", { timeoutMs: 5_000 });
    } catch {
      // the link may already be dead — close() below still rejects everything
    }
  }
  activeRun?.transport?.close();
}

// ---------------------------------------------------------------------------
// The migration leg's reachability probe (2026-11-02)
// ---------------------------------------------------------------------------

export interface MigrationProbeRequest {
  /** The SSH side of the NEW server (the same fields the provisioning form
   *  carries; validated by the same validateProvisioningParams gate). */
  host: string;
  sshPort: number;
  sshLogin: string;
  sshPassword: string | null;
  sshKeyPath: string | null;
  sshKeyPassphrase: string | null;
  /** The OLD server's https origin the NEW server will pull the archive from. */
  sourceUrl: string;
  /** The one-shot migration token (lands in a 0600 file, never a command line). */
  token: string;
  /** The OLD server's pinned TOFU fingerprint (hex) — gates the PEM capture. */
  pinnedFingerprint: string | null;
}

export interface MigrationProbeResult {
  direct: boolean;
  /** The failure reason when direct=false (the migration log line). */
  reason: string;
  /** The OLD server's certificate in PEM when a pin exists and matched —
   *  rides into provisioning:start as migrationTransfer.certificatePem. */
  certificatePem: string | null;
}

/**
 * Captures the OLD server's certificate through a ONE-SHOT verifyProc on the
 * session: the REST calls never surface a VALID certificate (only failures
 * reach certificate-error), so the PEM — which the receiving curl pins with
 * --cacert — is taken here. The capture is only armed when a TOFU pin exists
 * (a CA-valid domain deployment needs no PEM: the receiving system roots
 * verify it); the pin must match, or nothing is captured (the probe then runs
 * without --cacert and fails honestly → the through-this-computer fallback).
 */
async function captureServerCertificatePem(hostname: string, pinnedFingerprint: string | null): Promise<string | null> {
  if (pinnedFingerprint === null) {
    return null;
  }
  const session = electronSession.defaultSession;
  let captured: string | null = null;
  let settled = false;
  const verifyProc = (request: { hostname: string; certificate: Electron.Certificate }, callback: (verificationResult: number) => void): void => {
    if (!settled && request.hostname === hostname) {
      settled = true;
      const fingerprint = certFingerprintOfProc(request.certificate);
      if (fingerprint === pinnedFingerprint.toUpperCase()) {
        captured = request.certificate.data;
        callback(0); // the very pin the user already trusted — accept
        return;
      }
    }
    callback(-2); // not ours (or already captured) — Chromium's default verdict
  };
  session.setCertificateVerifyProc(verifyProc);
  try {
    await net.fetch(`https://${hostname}/api/server`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    // The response body does not matter — only the TLS handshake (a non-2xx or
    // even a transport failure past the handshake still captured the cert).
  } finally {
    session.setCertificateVerifyProc(null);
  }
  return captured;
}

/** SHA-256 of a certificate's DER — the same normalization the pin store uses. */
function certFingerprintOfProc(certificate: Electron.Certificate): string {
  if (typeof certificate.data !== "string" || certificate.data === "") {
    return "";
  }
  const der = Buffer.from(certificate.data.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
  if (der.length === 0) {
    return "";
  }
  return crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
}

/**
 * Probes whether the NEW server can pull the migration archive straight from
 * the OLD one: a short-lived SSH session writes the token (0600) and — when
 * captured — the pinned CA file, runs ONE curl against the transfer endpoint
 * (reachability + token validity + TLS trust in a single command) and reports
 * the verdict. The probe files are cleaned up before the session closes; the
 * token is NOT consumed by it (probe requests never count as a transfer).
 */
export async function probeMigrationDirectTransfer(request: MigrationProbeRequest): Promise<MigrationProbeResult> {
  const sshParams: ProvisioningParams = {
    host: request.host,
    sshPort: request.sshPort,
    sshLogin: request.sshLogin,
    sshPassword: request.sshPassword,
    sshKeyPath: request.sshKeyPath,
    sshKeyPassphrase: request.sshKeyPassphrase,
    domain: null,
    firewall: false,
    adminLogin: "probe",
    adminNickname: null,
    adminPassword: "probe-probe",
    jarPath: null,
    backupArchivePath: null,
  };
  const validation = validateProvisioningParams(sshParams);
  if (validation !== null) {
    return { direct: false, reason: validation, certificatePem: null };
  }
  if (!/^https:\/\/[A-Za-z0-9.:-]+$/.test(request.sourceUrl) || !/^[A-Za-z0-9_-]{20,100}$/.test(request.token)) {
    return { direct: false, reason: "the migration source or token failed validation", certificatePem: null };
  }
  const hostname = new URL(request.sourceUrl).hostname;
  const certificatePem = await captureServerCertificatePem(hostname, request.pinnedFingerprint);
  const workDir = "/tmp/space-migration-probe";
  const authFile = `${workDir}/.migration-auth`;
  const caFile = `${workDir}/old-ca.pem`;
  let transport: Ssh2Transport | null = null;
  try {
    transport = await Ssh2Transport.connect(sshParams);
    await transport.exec(`mkdir -p ${workDir}`, { timeoutMs: 15_000 });
    await transport.writeFile(authFile, `X-Space-Migration-Token: ${request.token}\n`, { mode: 0o600 });
    if (certificatePem !== null) {
      await transport.writeFile(caFile, certificatePem, { mode: 0o600 });
    }
    const trustArgs = certificatePem !== null ? ` --cacert ${caFile}` : "";
    const probe = await transport.exec(
      `curl -fsS --max-time 10${trustArgs} -H @${authFile} -o /dev/null -w '%{http_code}' ${request.sourceUrl}/api/server/backup/transfer/status`,
      { timeoutMs: 30_000 },
    );
    const direct = probe.code === 0 && probe.stdout.trim() === "204";
    return {
      direct,
      reason: direct
        ? "the new server reaches the old one directly"
        : `the direct probe failed (exit ${probe.code}, HTTP ${probe.stdout.trim() || "none"})`,
      certificatePem,
    };
  } catch (error) {
    return {
      direct: false,
      reason: `the direct probe could not run: ${error instanceof Error ? error.message : String(error)}`,
      certificatePem,
    };
  } finally {
    if (transport !== null) {
      try {
        await transport.exec(`rm -rf ${workDir}`, { timeoutMs: 10_000 });
      } catch {
        // best effort — the files carry only the short-lived token
      }
      transport.close();
    }
  }
}

/** SHA-256 of a local file (the fallback leg verifies the downloaded archive
 *  against the digest the issue response carried — a mid-flight archive
 *  replacement must not sail through on transport trust alone). Reads only
 *  inside the OS temp/downloads trees — never an arbitrary caller path. */
export async function hashLocalFile(absolutePath: string): Promise<string | null> {
  const resolved = path.resolve(absolutePath.trim());
  const allowedRoot = (root: string): boolean => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  if (!allowedRoot(app.getPath("temp")) && !allowedRoot(app.getPath("downloads"))) {
    return null;
  }
  return await new Promise<string | null>((resolve) => {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(resolved);
    stream.on("data", (chunk: string | Buffer) => {
      digest.update(chunk);
    });
    stream.on("end", () => resolve(digest.digest("hex")));
    stream.on("error", () => resolve(null));
  });
}
