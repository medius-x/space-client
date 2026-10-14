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
  runProvisioningPipeline,
  type ProvisioningFiles,
  type ProvisioningOutcome,
  type ProvisioningStage,
  type ProvisioningStepEvent,
  type ProvisioningTransport,
} from "../src/domain/provisioning/pipeline";
import { validateProvisioningParams, type ProvisioningParams } from "../src/domain/provisioning/params";

export type ProvisioningIpcEvent =
  | { kind: "step"; stage: ProvisioningStage | "connect" | "download"; state: "start" | "done" | "log" | "failed"; detail?: string }
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

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export class Ssh2Transport implements ProvisioningTransport {
  private readonly connection = new Client();
  private connected = false;

  static async connect(params: ProvisioningParams): Promise<Ssh2Transport> {
    const transport = new Ssh2Transport();
    await transport.openConnection(params);
    return transport;
  }

  private openConnection(params: ProvisioningParams): Promise<void> {
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
      const connectOptions: Record<string, unknown> = {
        host: params.host.trim(),
        port: params.sshPort,
        username: params.sshLogin.trim(),
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
      };
      if (params.sshPassword !== null && params.sshPassword.length > 0) {
        connectOptions.password = params.sshPassword;
      }
      if (params.sshKeyPath !== null && params.sshKeyPath.trim().length > 0) {
        connectOptions.privateKey = fs.readFileSync(params.sshKeyPath.trim());
      }
      this.connection.connect(connectOptions);
    });
  }

  async exec(command: string, options?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.connected) {
      return { code: -1, stdout: "", stderr: "connection closed" };
    }
    const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
      this.connection.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          // Long-running steps must not buffer unbounded output.
          if (stdout.length > 4_000_000) {
            stdout = stdout.slice(-2_000_000);
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          if (stderr.length > 1_000_000) {
            stderr = stderr.slice(-500_000);
          }
        });
        stream.on("close", (code: number | null) => {
          resolve({ code: code ?? -1, stdout, stderr });
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
    });
    return outcome;
  }

  async writeFile(remotePath: string, contents: string | Uint8Array): Promise<void> {
    if (!this.connected) {
      throw new Error("connection closed");
    }
    const sftp = await this.openSftp();
    await new Promise<void>((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on("close", () => resolve());
      writeStream.on("error", reject);
      writeStream.end(contents);
    });
  }

  async readFile(remotePath: string): Promise<string | null> {
    if (!this.connected) {
      return null;
    }
    const sftp = await this.openSftp();
    return await new Promise<string | null>((resolve) => {
      let data = "";
      const readStream = sftp.createReadStream(remotePath, { encoding: "utf8" });
      readStream.on("data", (chunk: string) => {
        data += chunk;
      });
      readStream.on("end", () => resolve(data));
      readStream.on("error", () => resolve(null));
    });
  }

  async writeLocalFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.connected) {
      throw new Error("connection closed");
    }
    const sftp = await this.openSftp();
    await new Promise<void>((resolve, reject) => {
      // LARGE chunks on both ends: Node's default 64 KB read chunks serialize
      // against the SFTP backpressure one round-trip at a time — on a ~200 ms
      // HK link that throttled image uploads to a crawl while the in-memory
      // writeFile path (the jar) flew (live report 2026-10-12). 4 MB chunks
      // let ssh2 pipeline its writes and fill the channel.
      const writeStream = sftp.createWriteStream(remotePath, { highWaterMark: 4 * 1024 * 1024 });
      writeStream.on("close", () => resolve());
      writeStream.on("error", reject);
      fs.createReadStream(localPath, { highWaterMark: 4 * 1024 * 1024 })
        .on("error", reject)
        .pipe(writeStream);
    });
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
    this.connected = false;
    this.sftpHandle = null;
    this.connection.end();
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
    emit({ kind: "step", ...event });
  };

  let transport: Ssh2Transport | null = null;
  let jarCleanup: (() => void) | null = null;
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
    const outcome = await runProvisioningPipeline(transport, params, files, stepEmit, (bytes) =>
      crypto.randomBytes(bytes).toString("hex"),
    );
    hooks.onSucceeded(outcome);
    emit({ kind: "succeeded", outcome });
    hooks.log(`[provisioning] deployment ready at ${outcome.hostUrl}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = error instanceof Error && "stage" in error ? String((error as { stage: unknown }).stage) : "connect";
    emit({ kind: "failed", stage, message });
    hooks.log(`[provisioning] FAILED (${stage}): ${message}`);
    return false;
  } finally {
    jarCleanup?.();
    transport?.close();
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
