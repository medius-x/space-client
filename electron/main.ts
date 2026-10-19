import { isSystemAudioAvailable, startSystemAudio, stopSystemAudio } from "./system-audio";
import { getClientSize, isWindowConfirmedDead, watchSourceLiveness } from "./window-liveness";
import { cancelProvisioningRun, startProvisioningRun } from "./provisioning";
import { app, BrowserWindow, contentTracing, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, safeStorage, screen, session, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { isBlockedAddress, PREVIEW_REDIRECT_LIMIT, previewUrlFromString } from "../src/domain/logic/net-guard";
import { logBucketName, outdatedLogBucketNames } from "../src/domain/logic/log-buckets";
import { certFingerprintsMatch, formatCertFingerprint, hostnameFromUrl, normalizeCertFingerprint } from "../src/domain/logic/cert-pin";

/**
 * Space spike — Electron main process.
 *
 * Deliberately thin: the whole protocol stack (REST/STOMP/Janus/WebRTC) lives in the
 * renderer (server CORS is wide open), so main only owns the window, the display-media
 * grant, and the security posture. DevTools stays open — this is a diagnostics spike.
 */

// ---------------------------------------------------------------------------
// space-asset:// — a read-only file protocol for the noise-suppression engines'
// heavy assets (wasm / models / worklet modules). The renderer CANNOT fetch()
// local files: the production window is a file:// document, and file→file fetch
// is blocked by CORS (origin null). Engines' assets live under the renderer's
// static root (src/renderer/public in dev, out/renderer in prod) and are served
// read-only from there; unknown or escaping paths are refused.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: "space-asset",
    // corsEnabled + the ACAO header below: the renderer is a file:// document
    // (origin null) — a cross-scheme fetch without them dies as "Failed to fetch".
    privileges: { standard: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const STATIC_ASSETS_ROOT = process.env.ELECTRON_RENDERER_URL
  ? path.resolve(app.getAppPath(), "src", "renderer", "public") // dev: vite serves them, main maps the same files
  : path.resolve(__dirname, "..", "renderer"); // prod: the built static tree next to index.html

function registerSpaceAssetProtocol(): void {
  protocol.handle("space-asset", async (request) => {
    // space-asset://df3/v3/x.wasm carries "df3" as the URL HOST — fold it back
    // into the relative path so callers write plain asset paths.
    const parsed = new URL(request.url);
    const relative = decodeURIComponent(`${parsed.host}${parsed.pathname}`.replace(/^\/+/, ""));
    const resolved = path.resolve(STATIC_ASSETS_ROOT, relative);
    if (!resolved.startsWith(STATIC_ASSETS_ROOT + path.sep)) {
      return new Response("forbidden", { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const fileResponse = await net.fetch(`file:///${resolved.split(path.sep).join("/")}`);
    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers: { ...fileResponse.headers, "Access-Control-Allow-Origin": "*" },
    });
  });
}

// Autoplay: the documented default is no-user-gesture-required but real-world reports
// disagree — set it both here and on the window below, and the renderer also calls
// audioContext.resume() from the login click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Hardware acceleration rescue. On hybrid-graphics laptops (NVIDIA dGPU +
// Intel iGPU) Chromium creates ANGLE on the Intel adapter, and its driver
// build can sit on the GPU blocklist — the whole compositor then silently
// falls back to SOFTWARE (log evidence: gpu_compositing/2d_canvas/raster all
// "disabled_software"), which renders exactly as the resize report described:
// the window flashes transparent and repaints from a small top-left rect,
// video decode eats CPU, and scrolling drags. Force past the blocklist and
// pin ANGLE to D3D11 (the stable Windows backend); harmless on healthy GPUs.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("use-angle", "d3d11");
// NOTE (resize artifact, 2026-09-24): during a live WIDTH drag the window
// shows the previous frame in a left rect with a transparent edge, and a full
// frame only paints on release. Tried and REJECTED here: --disable-direct-
// composition (changed the artifact to a full-height strip and let the window
// freeze mid-drag — strictly worse) and --disable-features=CalculateNative-
// WinOcclusion (no effect). Root cause is upstream: the Win32 modal resize
// loop blocks Chromium's browser main thread waiting for a right-sized
// renderer frame (CEF reports the same since Chromium ~138; plain Chrome on
// the same machine is clean). Renderer-side ruled out by logs: zero longtasks
// during the drag, near-empty channels flicker identically. Revisit at the
// packaging round (#470): newer Electron, packaged build, frame:true compare.

// Two-instance smoke on one machine is a FEATURE here: `electron . --space-instance=b`
// partitions userData (and with it the disk cache and localStorage — the second client
// logs in as a DIFFERENT user). No single-instance lock on purpose.
const instanceArgument = process.argv.find((arg) => arg.startsWith("--space-instance="));
const instanceName = instanceArgument ? instanceArgument.split("=")[1] : process.env.SPACE_INSTANCE;
if (instanceName) {
  app.setPath("userData", path.join(app.getPath("userData"), `instance-${instanceName}`));
}

// Optional CDP endpoint for `npm run profile` (scripts/capture-profile.mjs opens it,
// records a CPU profile of the renderer while you scroll, and closes the app).
// Opt-in by flag only — never on by default (an open debug port in packaged builds
// would be a hole).
const debugPortArgument = process.argv.find((arg) => arg.startsWith("--remote-debugging-port="));
if (debugPortArgument) {
  app.commandLine.appendSwitch("remote-debugging-port", debugPortArgument.split("=")[1]!);
}

// Frame tracing for the scroll-jank hunt: `--trace-frames=<seconds>` starts an
// Electron contentTracing recording once the window is up and dumps it into the
// project root as profile-trace.json (paint/raster/composite across ALL threads —
// what a renderer CPU profile cannot see). Opt-in flag, never default.
const traceFramesArgument = process.argv.find((arg) => arg.startsWith("--trace-frames="));
if (traceFramesArgument) {
  const traceSeconds = Number(traceFramesArgument.split("=")[1]);
  app.whenReady().then(() => {
    void contentTracing.startRecording({
      categoryFilter: "devtools.timeline",
      traceOptions: "record-until-full",
    }).then(() => {
      appendLog(`frame trace recording (${traceSeconds}s)…`);
      setTimeout(() => {
        void contentTracing.stopRecording().then((resultPath) => {
          try {
            fs.copyFileSync(resultPath, path.join(process.cwd(), "profile-trace.json"));
            appendLog(`frame trace saved to ${path.join(process.cwd(), "profile-trace.json")}`);
            console.log(`>>> frame trace saved: profile-trace.json`);
          } catch (error) {
            appendLog(`frame trace copy failed: ${String(error)}`);
          }
        });
      }, Math.max(1, traceSeconds) * 1000);
    });
  });
}

// File logging — the same workflow as oak-client's ~/.oak-client/*.log: smoke first,
// then the assistant reads the log file from disk. Every renderer line arrives over IPC
// (sandboxed renderers cannot touch the fs) and lands here next to the main-process ones.
// Ordered ASYNC appends: a sync write per line blocked the main thread (the
// cache IPC handlers share it — 2026-09-25 scroll-freeze round).
//
// Retention (logging round, 2026-10-06): the log lives in HOURLY bucket files
// userData/logs/space-<YYYYMMDD-HH>.log (UTC — the lines themselves are ISO-UTC), buckets
// older than 24 h are pruned on rollover and at startup, and the legacy unbounded
// userData/space.log is removed once. "Download client logs" (space-logs:collect)
// reads exactly this directory.
const fsp = fs.promises;
const logsDirectory = path.join(app.getPath("userData"), "logs");
let logWriteChain: Promise<void> = fsp.mkdir(logsDirectory, { recursive: true })
  .then(() => fsp.rm(path.join(app.getPath("userData"), "space.log"), { force: true })) // the legacy unbounded log
  .catch(() => {
    // logging must never take the app down
  })
  .then(() => pruneOldLogBuckets());
let currentLogBucket = "";

function pruneOldLogBuckets(): Promise<void> {
  return fsp.readdir(logsDirectory)
    .then((files) => {
      const stale = outdatedLogBucketNames(files, new Date());
      return Promise.all(stale.map((name) =>
        fsp.unlink(path.join(logsDirectory, name)).catch(() => undefined)));
    })
    .then(() => undefined)
    .catch(() => {
      // logging must never take the app down
    });
}

function appendLog(line: string): void {
  const bucket = logBucketName(new Date());
  const rolledOver = bucket !== currentLogBucket;
  if (rolledOver) {
    currentLogBucket = bucket;
  }
  logWriteChain = logWriteChain
    .then(() => (rolledOver ? pruneOldLogBuckets() : undefined))
    .then(() => fsp.appendFile(path.join(logsDirectory, bucket), `${new Date().toISOString()} ${line}\n`))
    .catch(() => {
      // logging must never take the app down
    });
}
ipcMain.on("space-log", (_event, line: unknown) => {
  if (typeof line === "string") {
    appendLog(line);
  }
});

// "Download client logs": flush the ordered write chain (the newest lines must be
// in the file), then hand the retention-window bucket files to the renderer, which
// zips and saves them. The log lines ride Uint8Arrays through the structured clone.
ipcMain.handle("space-logs:collect", async () => {
  await logWriteChain.catch(() => undefined);
  try {
    const files = (await fsp.readdir(logsDirectory)).sort();
    const collected: { name: string; bytes: Uint8Array }[] = [];
    for (const name of files) {
      const bytes = await fsp.readFile(path.join(logsDirectory, name));
      collected.push({ name: `logs/${name}`, bytes: new Uint8Array(bytes) });
    }
    return collected;
  } catch (error) {
    appendLog(`[logs] collect failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
});
// The boot line is the first thing read in an exported archive — it must identify
// the build AND the machine: the OS release (10.0.22631 etc.) separates "a Windows
// 11 quirk" from "an old build" at a glance (user request, logging round smoke).
appendLog(`--- space started (main) v${app.getVersion()} ${process.platform}-${process.arch} os=${os.release()} instance=${instanceName ?? "a"} ---`);

// KV store: atomic JSON files in userData. set() with an UPDATER runs the
// read-modify-write under a per-key lock IN THIS PROCESS — token rotation and UI
// writes (lastChannel/prefs/volume flushes) can never clobber each other (the
// lost-update bug the Java client had to learn the hard way).
const kvLocks = new Map<string, Promise<unknown>>();

function kvPath(key: string): string {
  const safe = key.replace(/[^a-z0-9-_.]/gi, "_");
  return path.join(app.getPath("userData"), `${safe}.json`);
}

// M7 (security round 7): connection records carry live refresh tokens, and their
// KV files sat as PLAINTEXT JSON in userData. Records are now encrypted WHOLE via
// safeStorage (OS keychain) with an "enc:v1:" marker; a pre-M7 plaintext file
// still reads (migration happens on the next write of that key). When safeStorage
// is unavailable the values persist as before — logged once, not per write.
const KV_ENCRYPTED_PREFIX = "enc:v1:";
const KV_ENCRYPTED_KEYS = /^connection:/;
let warnedPlaintextKv = false;

function kvEncode(key: string, json: string): string {
  if (!KV_ENCRYPTED_KEYS.test(key)) {
    return json;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedPlaintextKv) {
      warnedPlaintextKv = true;
      appendLog("[kv] safeStorage unavailable — connection records stay plaintext (M7 boundary)");
    }
    return json;
  }
  return KV_ENCRYPTED_PREFIX + safeStorage.encryptString(json).toString("base64");
}

function kvRead(key: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(kvPath(key), "utf8");
  } catch {
    return null;
  }
  if (raw.startsWith(KV_ENCRYPTED_PREFIX)) {
    // Ciphertext without a keychain (moved profile, locked keychain) reads as
    // absent — the record shows up as needs-re-login, which is the honest state.
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      const decrypted = safeStorage.decryptString(
        Buffer.from(raw.slice(KV_ENCRYPTED_PREFIX.length), "base64"),
      );
      return JSON.parse(decrypted) as unknown;
    } catch (error) {
      appendLog(`[kv] decrypt ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

ipcMain.handle("space-kv:get", (_event, key: unknown) => {
  return typeof key === "string" ? kvRead(key) : null;
});

/** All mutations run serialized per key (functions cannot cross IPC — hence the
 *  declarative op kinds; compare-and-swap covers token rotation races). */
async function kvMutate(key: string, apply: (current: unknown) => unknown): Promise<unknown> {
  const previous = kvLocks.get(key) ?? Promise.resolve();
  const job = previous.then(() => {
    // The TOFU certificate pin (see the TLS section below) rides along on
    // connection-record writes — a plain `apply` result never carries it.
    const next = withSessionCertificatePin(apply(kvRead(key)));
    try {
      fs.writeFileSync(kvPath(key), kvEncode(key, JSON.stringify(next ?? null, null, 2)));
    } catch (error) {
      appendLog(`[kv] write ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return next;
  });
  kvLocks.set(key, job.catch(() => undefined));
  return job;
}

ipcMain.handle("space-kv:set", (_event, key: unknown, value: unknown) => {
  return typeof key === "string" ? kvMutate(key, () => value) : null;
});

/** Delete also runs under the per-key lock — a concurrent merge cannot resurrect the file. */
async function kvDelete(key: string): Promise<null> {
  const previous = kvLocks.get(key) ?? Promise.resolve();
  const job = previous.then(() => {
    try {
      fs.unlinkSync(kvPath(key));
    } catch {
      // already gone — delete is idempotent
    }
    return null;
  });
  kvLocks.set(key, job.catch(() => undefined));
  return job;
}

ipcMain.handle("space-kv:delete", (_event, key: unknown) => {
  return typeof key === "string" ? kvDelete(key) : null;
});

// Returns SANITIZED key names (filename minus .json). Callers that stick to
// sanitize-stable ids (uuid) can slice their prefix off verbatim.
ipcMain.handle("space-kv:keys", (_event, prefix: unknown) => {
  if (typeof prefix !== "string") {
    return [];
  }
  try {
    return fs
      .readdirSync(app.getPath("userData"))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
});

// Disk cache for attachment images, keyed by the STABLE MinIO key (presigned URLs
// re-sign per fetch, so the HTTP cache is useless). Trim is LRU-by-mtime.
// ALL of it is ASYNC fs: IPC handlers run on the MAIN thread, and the sync
// trio (writeFileSync per put, readFileSync per get, readdir+stat per trim)
// used to block the whole process — scroll over a cached channel queued dozens
// of sync reads while the idle prefetch's after-every-put trim walked EVERY
// cache file with statSync; the renderer starved waiting for IPC replies and
// dropped frames (live report 2026-09-25).
function cacheDir(): string {
  const dir = path.join(app.getPath("userData"), "cache");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best effort
  }
  return dir;
}

function cachePath(key: string): string {
  return path.join(cacheDir(), key.replace(/[^a-z0-9-_.]/gi, "_"));
}

ipcMain.handle("space-cache:put", async (_event, key: unknown, bytes: unknown) => {
  if (typeof key !== "string" || !(bytes instanceof Uint8Array)) {
    return false;
  }
  try {
    await fsp.writeFile(cachePath(key), bytes);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("space-cache:get", async (_event, key: unknown) => {
  if (typeof key !== "string") {
    return null;
  }
  try {
    const filePath = cachePath(key);
    const bytes = await fsp.readFile(filePath);
    const now = new Date();
    // touch for LRU — best effort, never blocks the read
    void fsp.utimes(filePath, now, now).catch(() => undefined);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle("space-cache:trim", async (_event, maxBytes: unknown) => {
  const budget = typeof maxBytes === "number" ? maxBytes : 256 * 1024 * 1024;
  try {
    const dir = cacheDir();
    const names = await fsp.readdir(dir);
    const entries: { full: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        entries.push({ full, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // raced away — skip it
      }
    }
    entries.sort((left, right) => left.mtime - right.mtime); // oldest first
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= budget) {
        break;
      }
      try {
        await fsp.unlink(entry.full);
        total -= entry.size;
      } catch {
        // already gone
      }
    }
    return total;
  } catch {
    return 0;
  }
});

// External links open in the system browser (the window denies its own popups).
ipcMain.handle("space-shell:openExternal", (_event, url: unknown) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return false;
  }
  void shell.openExternal(url);
  return true;
});

// Global hotkeys (2026-09-18): the OS-level chord that mutes the mic while the
// window has NO focus (the user is in a game). The renderer OWNS the map — it
// pushes the full global set after every keybinds change; main just re-registers
// it wholesale (unregisterAll + register — the map is tiny). register() fails
// SILENTLY on Windows when another process (a second dev instance, another app)
// already holds the chord, so the per-action status is probed with
// isRegistered() AFTER the attempt: "taken" surfaces in the settings UI.
ipcMain.handle("space-hotkey:sync", (_event, entries: unknown): Record<string, "ok" | "taken"> => {
  globalShortcut.unregisterAll();
  const status: Record<string, "ok" | "taken"> = {};
  if (!Array.isArray(entries)) {
    return status;
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string"
      || typeof (entry as { accelerator?: unknown }).accelerator !== "string") {
      continue;
    }
    const { id, accelerator } = entry as { id: string; accelerator: string };
    try {
      globalShortcut.register(accelerator, () => {
        // Only the MAIN window runs the runtime; toast/popout never load it. A
        // press while the renderer is dead is dropped — fire-and-forget, the
        // same contract as toast:clicked.
        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
          mainWindowRef.webContents.send("space-hotkey:press", id);
        }
      });
    } catch (error) {
      appendLog(`[hotkey] register ${id} "${accelerator}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    status[id] = globalShortcut.isRegistered(accelerator) ? "ok" : "taken";
    appendLog(`[hotkey] ${id} "${accelerator}" → ${status[id]}`);
  }
  return status;
});

// OG link-preview fetching (oak's LinkPreviewService counterpart). The renderer's
// own fetch is CORS-bound; the MAIN process net stack is not, so page HTML and
// preview images travel through this channel. Hard limits: http(s) only, a byte
// cap per kind, an abort timeout.
//
// M5 (security round 7) — the SSRF gate: without an address check this channel is
// a free proxy into the machine's own network (localhost services, router panels,
// cloud metadata). Every hostname — the initial URL's and EACH redirect's — is
// DNS-resolved first and refused when ANY resolved address is blocked
// (private/loopback/link-local, v4+v6; see src/domain/logic/net-guard.ts).
// Redirects are followed MANUALLY precisely so each Location is re-checked — an
// auto-following fetch re-resolves blind and pivots straight into 169.254.169.254.
// A blocked target is a silent null — no preview, no error surfaced. Known
// residual: the DNS answer is checked, then net.fetch resolves again
// independently — a rebinding attacker can serve a public IP to the check and a
// private one to the fetch; pinning the connection to the checked IP breaks TLS
// SNI, so the residual is documented, not patched.
const NET_FETCH_TIMEOUT_MS = 8000;
const NET_TEXT_CAP_BYTES = 512 * 1024;
const NET_IMAGE_CAP_BYTES = 2 * 1024 * 1024;

/** M5: resolves the hostname and refuses when any answer is blocked (or the name
 *  does not resolve at all — the gate fails closed). */
async function isPreviewHostBlocked(hostname: string): Promise<boolean> {
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.length === 0 || answers.some((answer) => isBlockedAddress(answer.address));
  } catch {
    return true;
  }
}

ipcMain.handle("space-net:fetch", async (_event, url: unknown, kind: unknown) => {
  if (typeof url !== "string" || (kind !== "text" && kind !== "image")) {
    return null;
  }
  try {
    let current = previewUrlFromString(url);
    if (current === null || await isPreviewHostBlocked(current.hostname)) {
      return null;
    }
    let response: Response;
    for (let hop = 0; ; hop++) {
      response = await net.fetch(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
      });
      const redirecting = [301, 302, 303, 307, 308].includes(response.status)
        && response.headers.get("location") !== null;
      if (!redirecting) {
        break;
      }
      if (hop >= PREVIEW_REDIRECT_LIMIT) {
        return null; // a redirect chain past the limit is a loop — no preview
      }
      const next = previewUrlFromString(new URL(response.headers.get("location")!, current).toString());
      if (next === null || await isPreviewHostBlocked(next.hostname)) {
        return null; // a redirect into blocked space is the classic SSRF pivot
      }
      current = next;
    }
    if (!response.ok) {
      return null;
    }
    const cap = kind === "text" ? NET_TEXT_CAP_BYTES : NET_IMAGE_CAP_BYTES;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      // manual redirects leave response.url at the last hop — the tracked URL is
      // the truth (relative og:image resolution needs the final one).
      finalUrl: current.toString(),
      contentType: response.headers.get("content-type") ?? "",
      // Over-cap responses are truncated, not fatal — the OG parser only needs <head>.
      data: buffer.slice(0, cap),
    };
  } catch {
    return null;
  }
});

// Save dialog for downloads (lightbox "Save").
ipcMain.handle("space-file:save", async (_event, fileName: unknown, bytes: unknown) => {
  if (typeof fileName !== "string" || !(bytes instanceof Uint8Array)) {
    return null;
  }
  const chosen = await dialog.showSaveDialog({
    defaultPath: fileName,
  });
  if (chosen.canceled || chosen.filePath === undefined) {
    return null;
  }
  try {
    fs.writeFileSync(chosen.filePath, bytes);
    return chosen.filePath;
  } catch (error) {
    // The user picked a destination and the write still failed — without this line
    // the failure is indistinguishable from "canceled" everywhere (logging round).
    appendLog(`[file] save to "${chosen.filePath}" failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
});

ipcMain.handle("space-kv:merge", (_event, key: unknown, partial: unknown) => {
  if (typeof key !== "string" || typeof partial !== "object" || partial === null) {
    return null;
  }
  return kvMutate(key, (current) => ({ ...(current as object ?? {}), ...(partial as object) }));
});

// ---------------------------------------------------------------------------
// TLS entry point (round B): trust-on-first-use certificate pinning for
// self-signed deployments — a bare-IP host cannot obtain a CA certificate, so
// the user confirms the SHA-256 fingerprint once, it is pinned to the server
// record, and every later connection compares against the pin. The pin is
// keyed by HOSTNAME, not origin: one Caddy certificate covers the oak host on
// 443, MinIO on 9443 and the /janus route — three origins, one pin.
// ---------------------------------------------------------------------------

/** Hostnames the user accepted THIS SESSION (hostname → normalized SHA-256). */
const sessionAcceptedCertificates = new Map<string, string>();

/** The pinned fingerprint stored on the server record for this hostname (null =
 *  no pin yet). Direct KV read of the sanitized connection_*.json files — the
 *  certificate-error event is rare, no cache is worth invalidation plumbing. */
function persistedPinForHostname(hostname: string): string | null {
  try {
    const names = fs.readdirSync(app.getPath("userData"))
      .filter((name) => name.startsWith("connection_") && name.endsWith(".json"));
    for (const name of names) {
      const record = kvRead(name.slice(0, -".json".length)) as
        { hostUrl?: unknown; certFingerprint?: unknown } | null;
      if (record !== null && typeof record.hostUrl === "string"
          && hostnameFromUrl(record.hostUrl) === hostname
          && typeof record.certFingerprint === "string" && record.certFingerprint !== "") {
        return record.certFingerprint;
      }
    }
  } catch {
    // best effort — an unreadable dir reads as "no pin"
  }
  return null;
}

/** A connection-record write adopts the certificate the user accepted this
 *  session for the record's host: the TOFU pin persists with the record (and a
 *  deliberately re-trusted certificate change refreshes it). */
function withSessionCertificatePin(next: unknown): unknown {
  if (next === null || typeof next !== "object") {
    return next;
  }
  const record = next as { hostUrl?: unknown; certFingerprint?: unknown };
  if (typeof record.hostUrl !== "string") {
    return next;
  }
  const hostname = hostnameFromUrl(record.hostUrl);
  if (hostname === null) {
    return next;
  }
  const pin = sessionAcceptedCertificates.get(hostname);
  if (pin === undefined || record.certFingerprint === pin) {
    return next;
  }
  return { ...record, certFingerprint: pin };
}

/** Surfaces a rejected certificate to the login UI — the user decides. */
function notifyUntrustedCertificate(hostname: string, fingerprint: string, subjectName: string, changedPinned: boolean): void {
  sendToMainWindow("tls:untrusted", {
    hostname,
    fingerprint,
    displayFingerprint: formatCertFingerprint(fingerprint),
    subjectName,
    changedPinned,
  });
}

/** SHA-256 of the certificate's DER encoding — byte-identical to
 *  `openssl x509 -fingerprint -sha256` and to what the trust dialog shows.
 *  Computed from certificate.data on purpose: Electron 44's typings expose only
 *  the SHA-1 `fingerprint`, and SHA-1 is not a pinning-grade hash. */
function certFingerprintOf(certificate: Electron.Certificate): string {
  if (typeof certificate.data !== "string" || certificate.data === "") {
    return "";
  }
  const der = Buffer.from(certificate.data.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
  if (der.length === 0) {
    return "";
  }
  return crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
}

/** Persists the just-accepted pin onto EVERY record of this host right away.
 *  Relying on a later record write left the connection retry racing the stale
 *  persisted pin (and a client restart before any record write would silently
 *  drop the acceptance) — the decide handler calls this immediately. */
function persistAcceptedPin(hostname: string): void {
  try {
    const names = fs.readdirSync(app.getPath("userData"))
      .filter((name) => name.startsWith("connection_") && name.endsWith(".json"));
    for (const name of names) {
      const key = name.slice(0, -".json".length);
      const record = kvRead(key) as { hostUrl?: unknown; certFingerprint?: unknown } | null;
      if (record === null || typeof record.hostUrl !== "string"
          || hostnameFromUrl(record.hostUrl) !== hostname
          || record.certFingerprint === sessionAcceptedCertificates.get(hostname)) {
        continue;
      }
      // The identity mutation still passes through withSessionCertificatePin in
      // kvMutate — that is the write that adopts the accepted pin.
      void kvMutate(key, (current) => current);
    }
  } catch (error: unknown) {
    appendLog(`[tls] pin persist sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The verdict owner for EVERY https/wss connection (REST, the /ws STOMP
// upgrade, MinIO presigned URLs, the Janus long-poll): a valid CA-signed
// certificate never lands here — only validation failures do, so a
// Let's-Encrypt deployment simply never meets its pinned cousin.
app.on("certificate-error", (event, _webContents, url, _error, certificate, callback) => {
  event.preventDefault();
  const hostname = hostnameFromUrl(url);
  const fingerprint = certFingerprintOf(certificate);
  if (hostname === null || fingerprint === "") {
    callback(false);
    return;
  }
  // The user accepted THIS EXACT fingerprint moments ago (the trust dialog's
  // Connect): the retry MUST pass even while the persisted pin still holds the
  // OLD certificate — a re-trusted change is exactly what the acceptance means.
  // Checking the pin first re-blocked the retry in the mismatch branch below
  // and re-opened the dialog in a loop (live 2026-10-08: "Connect → dialog
  // reappears / Reconnecting forever").
  if (sessionAcceptedCertificates.get(hostname) === fingerprint) {
    callback(true);
    return;
  }
  const pinned = persistedPinForHostname(hostname);
  if (pinned !== null && certFingerprintsMatch(pinned, fingerprint)) {
    callback(true); // the pinned self-signed certificate — the whole point
    return;
  }
  if (pinned !== null) {
    // A PINNED host presents a DIFFERENT certificate: possible MITM — block and
    // surface the change loudly (a legitimate server reinstall re-trusts through
    // the same dialog).
    appendLog(`[tls] certificate CHANGED for ${hostname}: pinned ${pinned.slice(0, 16)}…, presented ${fingerprint.slice(0, 16)}… — blocked`);
    callback(false);
    notifyUntrustedCertificate(hostname, fingerprint, certificate.subjectName, true);
    return;
  }
  // No pin, nothing accepted: reject now and let the user decide; the retried
  // connection passes through the session allowance above.
  appendLog(`[tls] untrusted certificate for ${hostname} (${fingerprint.slice(0, 16)}…) — awaiting the user's decision`);
  callback(false);
  notifyUntrustedCertificate(hostname, fingerprint, certificate.subjectName, false);
});

ipcMain.handle("space-tls:decide", (_event, decision: unknown): boolean => {
  if (decision === null || typeof decision !== "object") {
    return false;
  }
  const { hostname, fingerprint, accept } = decision as
    { hostname?: unknown; fingerprint?: unknown; accept?: unknown };
  if (typeof hostname !== "string" || hostname === ""
      || typeof fingerprint !== "string" || fingerprint === "") {
    return false;
  }
  // One canonical form for the stored pin (the event carries it already; the
  // renderer echo is normalized defensively).
  const pin = normalizeCertFingerprint(fingerprint);
  if (accept === true) {
    sessionAcceptedCertificates.set(hostname, pin);
    persistAcceptedPin(hostname);
    appendLog(`[tls] user ACCEPTED certificate for ${hostname} (${pin.slice(0, 16)}…)`);
  } else {
    if (sessionAcceptedCertificates.get(hostname) === pin) {
      sessionAcceptedCertificates.delete(hostname);
    }
    appendLog(`[tls] user REJECTED certificate for ${hostname}`);
  }
  return true;
});

// ---------------------------------------------------------------------------
// Server provisioning (round C): the Create tab drives an SSH deployment of
// the whole OAK stack on a fresh Ubuntu host. The renderer starts/cancels and
// renders the step events; the heavy lifting (ssh2, the templates, the jar)
// lives in ./provisioning. SSH credentials never pass through the log.
// ---------------------------------------------------------------------------
ipcMain.handle("provisioning:start", (_event, params: unknown): boolean => {
  if (typeof params !== "object" || params === null) {
    return false;
  }
  void startProvisioningRun(params as never, {
    sendEvent: (event) => {
      sendToMainWindow("provisioning:event", event);
    },
    onSucceeded: (outcome) => {
      // The certificate fingerprint arrived over the TRUSTED SSH channel —
      // the deployment's own certificate is pre-trusted without a dialog,
      // which is exactly what the TOFU dialog's "verify with the server
      // owner" step asks the user to do by hand.
      if (outcome.certFingerprint !== null) {
        const hostname = hostnameFromUrl(outcome.hostUrl);
        if (hostname !== null) {
          sessionAcceptedCertificates.set(hostname, outcome.certFingerprint);
          persistAcceptedPin(hostname);
        }
      }
    },
    log: (line) => appendLog(line),
  });
  return true;
});

ipcMain.handle("provisioning:cancel", () => {
  cancelProvisioningRun();
  appendLog("[provisioning] cancelled by the user");
  return true;
});

ipcMain.handle("space-kv:rotate-tokens", (_event, key: unknown, expectedRefreshToken: unknown, tokens: unknown) => {
  if (typeof key !== "string") {
    return null;
  }
  return kvMutate(key, (current) => {
    const record = (current ?? {}) as Record<string, unknown>;
    if (record.refreshToken !== expectedRefreshToken && typeof record.refreshToken === "string") {
      appendLog(`[kv] token rotation LOST the race for ${key} — keeping the newer record`);
      return record; // another rotation already won; drop ours
    }
    return { ...record, ...(tokens as object) };
  });
});

// ---------------------------------------------------------------------------
// Capture picker (M4): enumerate desktop sources WITH previews for the Discord-style
// picker, and hand the CHOSEN source to the next getDisplayMedia grant. The handler
// stays the single grant point — renderer-side chromeMediaSourceId constraints are
// unreliable when a display-media handler is installed.
// ---------------------------------------------------------------------------

let pendingCaptureGrant: { sourceId: string; withAudio: boolean } | null = null;

/** The share-grant anti-freeze cache: the picker's `space-capture:sources`
 *  call enumerated everything seconds before Share, and re-running
 *  desktopCapturer.getSources in the display-media grant handler would probe
 *  EVERY window through WGC a second time (0.5–2 s of GPU churn on this
 *  hardware — the share-start cursor-freeze suspect). A fresh FULL
 *  enumeration (screens + windows) may serve the grant directly; window hits
 *  are re-validated with a nanosecond IsWindow, and any miss falls back to
 *  the ordinary re-enumeration — correctness first, the cache is only speed. */
interface CaptureSourceCache {
  sources: Electron.DesktopCapturerSource[];
  enumeratedAt: number;
}

const CAPTURE_SOURCE_CACHE_TTL_MS = 30_000;

let captureSourceCache: CaptureSourceCache | null = null;

/** Caption-bar window controls (borderless chrome, oak parity). Resolved by
 *  SENDER: the main window and the share pop-out both render a CaptionBar,
 *  and each button must act on ITS OWN window. */
ipcMain.on("space-window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("space-window:maximize", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === undefined || window === null) {
    return;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
});
ipcMain.on("space-window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
// The pop-out's volume sliders: the AUDIO plays in the main window (the pop-out
// subscribes video-only), so the value forwards there and applies to the picked
// chain (share or the peer's voice) / persists per username. The kind is
// validated — a malformed channel name must never reach the renderer.
ipcMain.on("space-window:popoutVolume", (_event, username: unknown, volume: unknown, kind: unknown) => {
  if (typeof username !== "string" || typeof volume !== "number" || !Number.isFinite(volume)
    || (kind !== "voice" && kind !== "share")) {
    return;
  }
  sendToMainWindow("popout:volume", username, Math.min(2, Math.max(0, volume)), kind);
});
// MAIN → pop-out: a gain changed in the main window (slider sync).
ipcMain.on("space-window:pushPopoutVolume", (_event, username: unknown, gain: unknown, kind: unknown) => {
  if (typeof username !== "string" || typeof gain !== "number" || !Number.isFinite(gain)
    || (kind !== "voice" && kind !== "share")) {
    return;
  }
  sendToPopoutWindow("popout:volumeSync", username, gain, kind);
});
// MAIN → pop-out: the voice-panel mirror (mute/deafen/NS) — kept for the
// pop-out's initial state, forwarded live while it is open.
let lastPopoutVoiceState: Record<string, unknown> | null = null;
ipcMain.on("space-window:pushPopoutVoiceState", (_event, state: unknown) => {
  if (state === null || typeof state !== "object") {
    return;
  }
  lastPopoutVoiceState = state as Record<string, unknown>;
  sendToPopoutWindow("popout:voiceState", state);
});
ipcMain.handle("space-window:popoutVoiceState", () => lastPopoutVoiceState);
// POP-OUT → main: voice-panel button presses run in the MAIN window's runtime.
ipcMain.on("space-window:popoutVoiceAction", (_event, action: unknown, engine: unknown) => {
  if (action !== "toggle-mute" && action !== "toggle-deafen" && action !== "ns-engine") {
    return;
  }
  sendToMainWindow("popout:voiceAction", action, typeof engine === "string" ? engine : null);
});
ipcMain.on("space-window:toggleFullscreen", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window !== undefined && window !== null) {
    window.setFullScreen(!window.isFullScreen());
  }
});

ipcMain.handle("space-capture:sources", async (_event, requestedTypes: unknown) => {
  try {
    // Optional type filter: the self-test only needs screens, and skipping the
    // window enumeration avoids Chromium's WGC probing of uncapturable windows
    // (the "Source is not capturable" console errors) plus most of the latency.
    const requested = Array.isArray(requestedTypes)
      ? requestedTypes.filter((entry): entry is "screen" | "window" => entry === "screen" || entry === "window")
      : [];
    const types: ("screen" | "window")[] = requested.length > 0 ? requested : ["screen", "window"];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
    });
    // Only a FULL enumeration can serve a later grant — a screens-only call
    // (the self-test) would miss every window id.
    if (types.includes("screen") && types.includes("window")) {
      captureSourceCache = { sources, enumeratedAt: Date.now() };
    }
    // The picker's resolution cutoff: physical pixels per source. Screens by
    // display_id (DIP size × scale factor), windows by the client-rect probe
    // (WGC captures the client area). Unknown = null = no cutoff offered.
    const screenSizes = new Map(screen.getAllDisplays().map((display) => [
      String(display.id),
      {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    ]));
    return sources.map((source) => {
      const isScreen = source.id.startsWith("screen:");
      const size = isScreen
        ? screenSizes.get(source.display_id) ?? null
        : getClientSize(source.id);
      return {
        id: source.id,
        name: source.name,
        kind: isScreen ? ("screen" as const) : ("window" as const),
        thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
        sourceWidth: size !== null ? size.width : null,
        sourceHeight: size !== null ? size.height : null,
      };
    });
  } catch (error: unknown) {
    appendLog(`[main] capture sources failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
});

ipcMain.handle("space-capture:select", (_event, sourceId: unknown, withAudio: unknown) => {
  if (typeof sourceId !== "string") {
    return false;
  }
  pendingCaptureGrant = { sourceId, withAudio: withAudio === true };
  return true;
});

// Window-share liveness watchdog (the oak SfuService precedent): Chromium
// never fires the capture track's "ended" when the shared window closes —
// WGC freezes the last frame and the ghost share keeps publishing. Main
// polls IsWindow and tells the renderer, which stops the share the ordinary way.
ipcMain.handle("space-capture:watchSource", (_event, sourceId: unknown) => {
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    return watchSourceLiveness(null, () => undefined); // cancel any running watch
  }
  return watchSourceLiveness(sourceId, (deadSourceId) => {
    appendLog(`[share] watched window died (${deadSourceId})`);
    sendToMainWindow("space-capture:sourceDead", deadSourceId);
  });
});

// ---------------------------------------------------------------------------
// System-idle time (the AFK sweep's client-side activity source): powerMonitor
// counts seconds since the last OS-WIDE user input — any app's mouse/keyboard
// keeps the member out of AFK, exactly the Discord "idle" semantics.
// ---------------------------------------------------------------------------
ipcMain.handle("space-idle:time", () => powerMonitor.getSystemIdleTime());

// ---------------------------------------------------------------------------
// Native system-audio capture (#485): WASAPI process-loopback, desktop minus
// OUR process — the OS-level replacement for the DSP subtraction. Frames flow
// fire-and-forget to the main window at the 10 ms drain cadence.
// ---------------------------------------------------------------------------
ipcMain.handle("space-sysaudio:available", () => isSystemAudioAvailable());
ipcMain.handle("space-sysaudio:start", async (_event, sourceId: unknown) => {
  const options = typeof sourceId === "string" && sourceId.length > 0 ? { sourceId } : {};
  const result = await startSystemAudio(
    (frame) => {
      sendToMainWindow("space-sysaudio:frame", frame.pcm, frame.silent);
    },
    (reason) => appendLog(`[sysaudio] native capture DIED (${reason})`),
    options,
  );
  const scope = result.mode === "include" ? `per-app pid ${result.pid}` : "desktop minus this process";
  appendLog(`[sysaudio] native capture ${result.started ? `started (${scope})` : `FAILED to start (${scope})`}`);
  return result.started;
});
ipcMain.handle("space-sysaudio:stop", () => {
  stopSystemAudio();
  appendLog("[sysaudio] native capture stopped");
});

// ---------------------------------------------------------------------------
// Share pop-out window (M4; 2026-09-21 rework): a separate BrowserWindow that
// runs its OWN videoroom subscription in its renderer (a MediaStream cannot
// cross renderer contexts, but a second Janus subscriber can — full quality
// and frame rate instead of the old 12.5 fps JPEG relay). Main only ferries
// the subscription target between the windows.
// ---------------------------------------------------------------------------

let popoutWindow: BrowserWindow | null = null;
let mainWindowRef: BrowserWindow | null = null;
/** The last target the main window pushed — the pop-out's initial state (its
 *  listener may mount after the retarget event was forwarded). */
let popoutTarget: Record<string, unknown> | null = null;

/** Fire-and-forget sends that can NEVER throw on a destroyed window. The
 *  2026-10-16 crash (TypeError "Object has been destroyed" inside a
 *  BrowserWindow event handler, main.js:2270) was a toast hover IPC racing
 *  the window's destruction during quit — `?.` checks null, not death. */
function sendToMainWindow(channel: string, ...args: unknown[]): void {
  if (mainWindowRef !== null && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, ...args);
  }
}

function sendToPopoutWindow(channel: string, ...args: unknown[]): void {
  if (popoutWindow !== null && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send(channel, ...args);
  }
}

function loadRendererTarget(window: BrowserWindow, hash: string): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    return window.loadURL(`${devServerUrl}#${hash}`);
  }
  return window.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { hash });
}

ipcMain.handle("space-window:popout", () => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return true;
  }
  const popout = new BrowserWindow({
    width: 880,
    height: 520,
    minWidth: 420,
    minHeight: 300,
    title: "space — screen share",
    frame: false, // the SAME borderless chrome as the main window — the pop-out renders its own CaptionBar (2026-09-25 style round)
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false, // frames must flow while the main window is focused
    },
  });
  // The main window's resize protections, mirrored here: the WM_ERASEBKGND
  // swallow (dark borderless windows flash WHITE on resize steps) and the
  // sliver-collapse guard (the unexplained native 44px flip).
  if (process.platform === "win32") {
    popout.hookWindowMessage(0x0014, () => undefined);
  }
  popout.on("will-resize", (event, newBounds) => {
    if (newBounds.width < 300 && popout.getBounds().width > 500) {
      event.preventDefault();
    }
  });
  popout.on("maximize", () => popout.webContents.send("space-window:maximized", true));
  popout.on("unmaximize", () => popout.webContents.send("space-window:maximized", false));
  popout.on("enter-full-screen", () => popout.webContents.send("space-window:fullscreen", true));
  popout.on("leave-full-screen", () => popout.webContents.send("space-window:fullscreen", false));
  popoutWindow = popout;
  popout.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popout.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "file://")) {
      event.preventDefault();
    }
  });
  popout.on("closed", () => {
    popoutWindow = null;
    popoutTarget = null;
    sendToMainWindow("popout:closed");
  });
  void loadRendererTarget(popout, "popout").catch((error: unknown) => {
    appendLog(`[main] popout load failed: ${error instanceof Error ? error.message : String(error)}`);
    popout.close();
  });
  return true;
});

ipcMain.on("space-window:retargetPopout", (_event, target: unknown) => {
  popoutTarget = target !== null && typeof target === "object" ? target as Record<string, unknown> : null;
  // The direct sidebar path stores the target BEFORE the window exists — this
  // line pins the layer when a pop-out ever sits waiting again (live report).
  appendLog(`[main] popout target ${popoutTarget !== null
    ? `stored (feed ${String(popoutTarget.feedId)}, mid ${String(popoutTarget.videoMid)})`
    : "cleared"}`);
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send("popout:retarget", target);
  }
});

ipcMain.handle("space-window:popoutParams", () => popoutTarget);

// ---------------------------------------------------------------------------
// Toast window (oak's NotificationToast): a frameless TRANSPARENT always-on-top
// overlay at the main window's screen bottom-right, hosting the toast stack —
// visible above every window, even with the app minimized (oak's whole point;
// its system-tray notifications never worked on Win10/11). Click-through
// everywhere except the cards: setIgnoreMouseEvents stays on and flips off only
// while the cursor hovers actual content (the overlay pattern). The window is
// NOT focusable — a card click routes through IPC to the MAIN window.
// ---------------------------------------------------------------------------

let toastWindow: BrowserWindow | null = null;
const TOAST_WINDOW_WIDTH = 320;
/** The toast page signals readiness after its IPC subscription is up — cards
 *  sent before that are LOST (the first toast never rendered, only its bell
 *  played — live report), so main buffers them until the signal. */
let toastWindowReady = false;
const pendingToastPayloads: unknown[] = [];

function ensureToastWindow(): BrowserWindow | null {
  if (toastWindow && !toastWindow.isDestroyed()) {
    return toastWindow;
  }
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return null;
  }
  toastWindowReady = false;
  const height = 480; // generous ceiling; the content reports its real height
  const area = screen.getDisplayMatching(mainWindowRef.getBounds()).workArea;
  const toast = new BrowserWindow({
    width: TOAST_WINDOW_WIDTH,
    height,
    x: area.x + area.width - TOAST_WINDOW_WIDTH - 12,
    y: area.y + area.height - height - 12,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // TTL timers must run while the main window is unfocused/minimized.
      backgroundThrottling: false,
    },
  });
  toastWindow = toast;
  toast.setAlwaysOnTop(true, "screen-saver");
  toast.setIgnoreMouseEvents(true, { forward: true }); // transparent areas click through
  toast.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  toast.webContents.on("render-process-gone", (_event, details) => {
    appendLog(`[main] TOAST renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  toast.on("unresponsive", () => appendLog("[main] TOAST window UNRESPONSIVE"));
  toast.on("closed", () => {
    toastWindow = null;
  });
  void loadRendererTarget(toast, "toasts").catch((error: unknown) => {
    appendLog(`[main] toast window load failed: ${error instanceof Error ? error.message : String(error)}`);
    toast.close();
  });
  return toast;
}

ipcMain.on("space-toast:show", (_event, payload: unknown) => {
  const payloadKind = typeof payload === "object" && payload !== null && "kind" in payload
    ? String((payload as { kind: unknown }).kind)
    : String(payload);
  const toast = ensureToastWindow();
  if (!toast) {
    appendLog(`[main] toast show kind=${payloadKind} DROPPED — no main window`);
    return;
  }
  if (!toastWindowReady) {
    appendLog(`[main] toast show kind=${payloadKind} buffered (toast window loading)`);
    pendingToastPayloads.push(payload);
    return; // shown once the page is ready — showing an unloaded window paints nothing
  }
  // Re-assert the topmost band on every show: after hide()/showInactive()
  // cycles Windows can drop the window out of the topmost band and a maximized
  // app covers it (live 2026-10-15: the call card surfaced UNDER a maximized
  // browser). moveTop then forces the z-order above the previously-active app.
  toast.setAlwaysOnTop(true, "screen-saver");
  toast.showInactive(); // visible, never stealing focus
  toast.moveTop();
  toast.webContents.send("toast:show", payload);
});

ipcMain.on("space-toast:ready", () => {
  const toast = toastWindow;
  if (!toast || toast.isDestroyed()) {
    return;
  }
  toastWindowReady = true;
  if (pendingToastPayloads.length > 0) {
    toast.setAlwaysOnTop(true, "screen-saver");
    toast.showInactive();
    toast.moveTop();
    for (const payload of pendingToastPayloads) {
      toast.webContents.send("toast:show", payload);
    }
    pendingToastPayloads.length = 0;
  }
});

// Interactive = the cursor is over actual content — only then the window
// accepts clicks; everywhere else it stays click-through. Transitions are
// logged (diagnostic, live 2026-10-15): no flip next to a click means the
// window never received the input at all (occluded), not a DOM fault.
let toastInteractive = false;
ipcMain.on("space-toast:hover", (_event, interactive: unknown) => {
  const next = interactive === true;
  if (next !== toastInteractive) {
    toastInteractive = next;
    appendLog(`[main] toast interactive=${next}`);
  }
  // isDestroyed guard (the crash of 2026-10-16): the hover IPC can land while
  // the toast window is being torn down during quit — `?.` checks null only.
  if (toastWindow !== null && !toastWindow.isDestroyed()) {
    toastWindow.setIgnoreMouseEvents(!next, { forward: true });
  }
});

ipcMain.on("space-toast:geometry", (_event, contentHeight: unknown) => {
  const toast = toastWindow;
  if (toast && !toast.isDestroyed() && typeof contentHeight === "number" && contentHeight > 0) {
    const bounds = toast.getBounds();
    const nextHeight = Math.max(48, Math.min(Math.ceil(contentHeight), 600));
    // Keep the BOTTOM-RIGHT corner anchored while the stack grows/shrinks.
    toast.setBounds({
      x: bounds.x,
      y: bounds.y + bounds.height - nextHeight,
      width: bounds.width,
      height: nextHeight,
    });
  }
});

ipcMain.on("space-toast:empty", () => {
  // No cards left — hide (kept alive for the next toast; it is click-through).
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.hide();
  }
});

ipcMain.on("space-toast:clicked", (_event, id: unknown) => {
  if (typeof id === "number") {
    sendToMainWindow("toast:clicked", id);
  }
});

// The incoming-call card's Accept/Decline — routed to the MAIN window renderer,
// where the runtime answers the call machine (same relay shape as card clicks).
ipcMain.on("space-toast:callAction", (_event, action: unknown) => {
  if (action === "accept" || action === "decline") {
    // Diagnostic (live 2026-10-15): clicks on a live call card once vanished
    // between the toast window and the runtime — every hop logs now.
    appendLog(`[main] toast call action ${action}`);
    sendToMainWindow("toast:callAction", action);
  }
});

// A voice-invite card's Join/Dismiss — the same main-window relay by card id.
ipcMain.on("space-toast:voiceInviteAction", (_event, action: unknown, id: unknown) => {
  if ((action === "join" || action === "dismiss") && typeof id === "number") {
    sendToMainWindow("toast:voiceInviteAction", action, id);
  }
});

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 693,
    title: "space",
    frame: false, // oak's borderless chrome — the renderer draws the caption bar
    backgroundColor: "#1e1f22",
    // Window/taskbar icon (placeholder art until the real logo). The existence
    // guard keeps packaged builds quiet — there the exe resource owns the icon.
    icon: fs.existsSync(path.join(app.getAppPath(), "electron", "build", "icon.png"))
      ? path.join(app.getAppPath(), "electron", "build", "icon.png")
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true, // default on modern Electron — pinned explicitly
      sandbox: true, // default — pinned explicitly
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      // Keepalive timers, long-polls and audio meters must survive minimizing the window.
      backgroundThrottling: false,
    },
  });
  // Windows-only white-flash killer on resize: the exposed strip behind the
  // not-yet-composited frame gets erased with the window class's WHITE brush
  // via WM_ERASEBKGND (0x14) — a dark frameless window flashes white on every
  // resize step, and no CSS/backgroundColor can help (it happens below the
  // page). Hooking the message swallows the erase entirely (Electron drops
  // hooked messages instead of running the default handling).
  if (process.platform === "win32") {
    mainWindow.hookWindowMessage(0x0014, () => undefined);
  }

  // Sliver-collapse guard (2026-09-24, live report): during a live resize drag
  // the window's REAL bounds were being flipped to a ~44px-wide sliver and
  // back on every tick (log-verified; visible as the whole-window flicker with
  // the content surviving only in a narrow left strip). The shrink never goes
  // through Electron's JS resize API (a prototype trap logged nothing) — it
  // arrives natively, will-resize being the only interception point. A window
  // wider than 500px never legitimately jumps below 300px in ONE step (a real
  // drag produces a tick ladder), so swallow exactly that transition; genuine
  // step-by-step shrinking by the user passes untouched. Candidate root-cause
  // hunt (koffi native modules in this process?) queued for the packaging
  // round (#470).
  mainWindow.on("will-resize", (event, newBounds) => {
    if (newBounds.width < 300 && mainWindow.getBounds().width > 500) {
      event.preventDefault();
    }
  });

  // The caption's maximize glyph flips on restore (oak's ▢↔❐).
  mainWindow.on("maximize", () => mainWindow.webContents.send("space-window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("space-window:maximized", false));
  // Liveness watch (2026-10-01, the voice-invite chase): a receiver logged the
  // incoming invite and then went fully silent — without these hooks a dead or
  // frozen renderer/main leaves NOTHING in space.log to tell which one died.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(`[main] MAIN renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.on("unresponsive", () => appendLog("[main] MAIN window UNRESPONSIVE (event loop blocked?)"));
  mainWindow.on("responsive", () => appendLog("[main] MAIN window responsive again"));
  // The auxiliary windows die with the main one — otherwise the app lingers
  // with an invisible toast overlay / a pop-out viewer.
  mainWindow.on("closed", () => {
    mainWindowRef = null; // guarded senders read null instead of a dead object
    if (toastWindow !== null && !toastWindow.isDestroyed()) {
      toastWindow.close();
    }
    if (popoutWindow !== null && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
    }
  });

  // Close-to-tray (user request 2026-10-07): the X button HIDES the window
  // instead of quitting — voice, long-polls and toast notifications keep
  // running (backgroundThrottling is off). The real quit lives in the tray
  // menu and runs the GRACEFUL path below: the renderer leaves voice/call
  // rooms first (voice.leave STOMP + Janus destroy HTTP within ~900 ms — the
  // phantom-tile fix of 2026-09-25), then the window closes for real.
  mainWindow.on("close", (event) => {
    if (gracefulQuitStarted || mainWindow.webContents.isDestroyed()) {
      return; // the deferred real close after the voice teardown
    }
    event.preventDefault();
    mainWindow.hide();
  });
  createTray(mainWindow);

  // Security: this spike never navigates anywhere except its own local page.
  mainWindowRef = mainWindow;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  // Display media grant. With a pending picker grant the CHOSEN source is handed out
  // (system loopback audio only for whole screens and only when the renderer asked);
  // without one this falls back to the primary display — the diagnostics self-test path.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const grant = pendingCaptureGrant;
    pendingCaptureGrant = null; // one grant per selection — never leak into a later request
    const handOut = (chosen: Electron.DesktopCapturerSource, fromCache: boolean): void => {
      const withLoopback = (grant?.withAudio ?? false) && request.audioRequested;
      appendLog(`[main] display-media grant: ${chosen.id} audio=${withLoopback ? "loopback" : "none"}${fromCache ? " (picker cache)" : ""}`);
      callback({ video: chosen, audio: withLoopback ? "loopback" : undefined });
    };
    // The anti-freeze fast path: the picker's own fresh enumeration serves the
    // grant without a second full WGC probe. Window ids are re-validated with
    // IsWindow (screen ids have no HWND — the probe does not apply to them);
    // a dead window or a cache miss simply falls through to the ordinary path.
    const cache = captureSourceCache;
    if (grant !== null && cache !== null && Date.now() - cache.enumeratedAt < CAPTURE_SOURCE_CACHE_TTL_MS
      && !(grant.sourceId.startsWith("window:") && isWindowConfirmedDead(grant.sourceId))) {
      const cached = cache.sources.find((source) => source.id === grant.sourceId);
      if (cached !== undefined) {
        handOut(cached, true);
        return;
      }
    }
    desktopCapturer
      .getSources({ types: grant ? ["screen", "window"] : ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        let chosen = grant ? sources.find((source) => source.id === grant.sourceId) : undefined;
        if (!chosen) {
          if (grant) {
            // The PICKED source died between the picker and the grant — refuse
            // honestly (the renderer's share-failed path) instead of silently
            // publishing the primary display as if it were the pick.
            appendLog(`[main] display-media: picked source "${grant.sourceId}" is gone`);
            callback({});
            return;
          }
          const primaryId = String(screen.getPrimaryDisplay().id);
          chosen = sources.find((source) => source.display_id === primaryId) ?? sources[0];
        }
        if (!chosen) {
          appendLog("[main] ERROR display-media: no sources available");
          callback({});
          return;
        }
        handOut(chosen, false);
      })
      .catch((error: unknown) => {
        appendLog(`[main] ERROR display-media failed: ${error instanceof Error ? error.message : String(error)}`);
        callback({});
      });
  });

  // DevTools are OPT-IN — the default window must look exactly like what a user
  // ships with (live M7 polish round). Two ways in: the SPACE_DEVTOOLS=1 env var
  // or the --space-devtools flag (npm scripts cannot set env vars portably on
  // Windows cmd.exe — the flag rides the same argv the instance split uses).
  if (process.env.SPACE_DEVTOOLS === "1" || process.argv.includes("--space-devtools")) {
    mainWindow.webContents.openDevTools({ mode: "bottom" });
  }
  // electron-vite convention: in `dev` the renderer must load the VITE DEV SERVER
  // (passed via ELECTRON_RENDERER_URL) — that is where HMR lives. Loading the built
  // out/renderer bundle in dev silently kills hot reload (caught in the M0 smoke).
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

// True between a tray-Quit (or app.quit()) and the deferred window close — the
// close handler must let THAT close through; every other close hides to tray.
let gracefulQuitStarted = false;

/** The tray-Quit path: let the renderer leave voice/call rooms first (the
 *  ~900 ms teardown that used to run on the X button), then close for real.
 *  A hidden trayed window is closed the same way. */
function initiateGracefulQuit(mainWindow: BrowserWindow): void {
  if (gracefulQuitStarted) {
    return;
  }
  gracefulQuitStarted = true;
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    app.quit();
    return;
  }
  mainWindow.webContents.send("app:closing");
  setTimeout(() => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  }, 900);
}

/** The tray icon (one per process — the dev two-instance smoke gets two).
 *  Quit runs the graceful path; Open/Click re-show the hidden window.
 *  Packaged: the icon rides in extraResources (resources/build/icon-48.png) —
 *  the project tree does not exist inside the asar, and close-to-tray WITHOUT
 *  a tray would hide the window into a zombie process (packaged smoke). */
function createTray(mainWindow: BrowserWindow): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "build", "icon-48.png")
    : path.join(app.getAppPath(), "electron", "build", "icon-48.png");
  if (!fs.existsSync(iconPath)) {
    // Nothing to anchor the tray with — X would then still hide; quit stays
    // possible via the taskbar context menu.
    appendLog("[main] WARN tray icon not found — running without a tray");
    return;
  }
  const tray = new Tray(iconPath);
  tray.setToolTip(instanceName ? `SPACE (${instanceName.toUpperCase()})` : "SPACE");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => initiateGracefulQuit(mainWindow) },
  ]));
  // Bare left-click shows the window — the Windows tray habit.
  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  // Windows identity for the taskbar/notification surfaces: without an explicit
  // AppUserModelID the tray/window group under the process name (electron.exe).
  app.setAppUserModelId("oak.space");
  // The app is dark, period — regardless of the Windows color scheme. Among
  // other things this makes Electron apply the DWM immersive-dark styling to
  // the native window, so any native paint behind the compositor (resize
  // exposure among them) is DARK instead of the light-theme white.
  nativeTheme.themeSource = "dark";
  registerSpaceAssetProtocol();
  void createWindow();
  app.on("activate", () => {
    // macOS habit — harmless on Windows, kept for free.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

// Main-process liveness (the voice-invite chase): a swallowed exception here
// starves EVERY renderer's logging (all lines travel through appendLog).
process.on("uncaughtException", (error) => {
  appendLog(`[main] UNCAUGHT ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  appendLog(`[main] UNHANDLED REJECTION ${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
});

app.on("window-all-closed", () => {
  app.quit();
});

// Any programmatic quit (auto-update later, OS shutdown paths that reach
// app.quit()) must not be eaten by the close-to-tray guard.
app.on("before-quit", () => {
  gracefulQuitStarted = true;
});

// OS-wide chords must die with the app — nothing else frees them.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
