import { isSystemAudioAvailable, startSystemAudio, stopSystemAudio } from "./system-audio";
import { getClientSize, isWindowConfirmedDead, watchSourceLiveness } from "./window-liveness";
import { app, BrowserWindow, contentTracing, desktopCapturer, dialog, globalShortcut, ipcMain, nativeTheme, net, powerMonitor, protocol, screen, session, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

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
const fsp = fs.promises;
const logFilePath = path.join(app.getPath("userData"), "space.log");
let logWriteChain: Promise<void> = Promise.resolve();
function appendLog(line: string): void {
  logWriteChain = logWriteChain
    .then(() => fsp.appendFile(logFilePath, `${new Date().toISOString()} ${line}\n`))
    .catch(() => {
      // logging must never take the app down
    });
}
ipcMain.on("space-log", (_event, line: unknown) => {
  if (typeof line === "string") {
    appendLog(line);
  }
});
appendLog("--- space started (main) ---");

// KV store: atomic JSON files in userData. set() with an UPDATER runs the
// read-modify-write under a per-key lock IN THIS PROCESS — token rotation and UI
// writes (lastChannel/prefs/volume flushes) can never clobber each other (the
// lost-update bug the Java client had to learn the hard way).
const kvLocks = new Map<string, Promise<unknown>>();

function kvPath(key: string): string {
  const safe = key.replace(/[^a-z0-9-_.]/gi, "_");
  return path.join(app.getPath("userData"), `${safe}.json`);
}

function kvRead(key: string): unknown {
  try {
    const raw = fs.readFileSync(kvPath(key), "utf8");
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
    const next = apply(kvRead(key));
    try {
      fs.writeFileSync(kvPath(key), JSON.stringify(next ?? null, null, 2));
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
// cap per kind, an abort timeout. Redirects resolve — the FINAL url comes back
// (relative og:image resolution needs it).
const NET_FETCH_TIMEOUT_MS = 8000;
const NET_TEXT_CAP_BYTES = 512 * 1024;
const NET_IMAGE_CAP_BYTES = 2 * 1024 * 1024;
ipcMain.handle("space-net:fetch", async (_event, url: unknown, kind: unknown) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || (kind !== "text" && kind !== "image")) {
    return null;
  }
  try {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    const cap = kind === "text" ? NET_TEXT_CAP_BYTES : NET_IMAGE_CAP_BYTES;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      finalUrl: response.url || url,
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
  } catch {
    return null;
  }
});

ipcMain.handle("space-kv:merge", (_event, key: unknown, partial: unknown) => {
  if (typeof key !== "string" || typeof partial !== "object" || partial === null) {
    return null;
  }
  return kvMutate(key, (current) => ({ ...(current as object ?? {}), ...(partial as object) }));
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
// The pop-out's volume slider: the AUDIO plays in the main window (the pop-out
// subscribes video-only), so the value forwards there and applies to the share
// chain / persists per username.
ipcMain.on("space-window:popoutVolume", (_event, username: unknown, volume: unknown) => {
  if (typeof username !== "string" || typeof volume !== "number" || !Number.isFinite(volume)) {
    return;
  }
  mainWindowRef?.webContents.send("popout:volume", username, Math.min(2, Math.max(0, volume)));
});
// MAIN → pop-out: the share gain changed in the main window (slider sync).
ipcMain.on("space-window:pushPopoutVolume", (_event, username: unknown, gain: unknown) => {
  if (typeof username !== "string" || typeof gain !== "number" || !Number.isFinite(gain)) {
    return;
  }
  popoutWindow?.webContents.send("popout:volumeSync", username, gain);
});
// MAIN → pop-out: the voice-panel mirror (mute/deafen/NS) — kept for the
// pop-out's initial state, forwarded live while it is open.
let lastPopoutVoiceState: Record<string, unknown> | null = null;
ipcMain.on("space-window:pushPopoutVoiceState", (_event, state: unknown) => {
  if (state === null || typeof state !== "object") {
    return;
  }
  lastPopoutVoiceState = state as Record<string, unknown>;
  popoutWindow?.webContents.send("popout:voiceState", state);
});
ipcMain.handle("space-window:popoutVoiceState", () => lastPopoutVoiceState);
// POP-OUT → main: voice-panel button presses run in the MAIN window's runtime.
ipcMain.on("space-window:popoutVoiceAction", (_event, action: unknown, engine: unknown) => {
  if (action !== "toggle-mute" && action !== "toggle-deafen" && action !== "ns-engine") {
    return;
  }
  mainWindowRef?.webContents.send("popout:voiceAction", action, typeof engine === "string" ? engine : null);
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
    mainWindowRef?.webContents.send("space-capture:sourceDead", deadSourceId);
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
      mainWindowRef?.webContents.send("space-sysaudio:frame", frame.pcm, frame.silent);
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
    mainWindowRef?.webContents.send("popout:closed");
  });
  void loadRendererTarget(popout, "popout").catch((error: unknown) => {
    appendLog(`[main] popout load failed: ${error instanceof Error ? error.message : String(error)}`);
    popout.close();
  });
  return true;
});

ipcMain.on("space-window:retargetPopout", (_event, target: unknown) => {
  popoutTarget = target !== null && typeof target === "object" ? target as Record<string, unknown> : null;
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
  toast.showInactive(); // visible, never stealing focus
  toast.webContents.send("toast:show", payload);
});

ipcMain.on("space-toast:ready", () => {
  const toast = toastWindow;
  if (!toast || toast.isDestroyed()) {
    return;
  }
  toastWindowReady = true;
  if (pendingToastPayloads.length > 0) {
    toast.showInactive();
    for (const payload of pendingToastPayloads) {
      toast.webContents.send("toast:show", payload);
    }
    pendingToastPayloads.length = 0;
  }
});

ipcMain.on("space-toast:hover", (_event, interactive: unknown) => {
  // Interactive = the cursor is over actual content — only then the window
  // accepts clicks; everywhere else it stays click-through.
  toastWindow?.setIgnoreMouseEvents(interactive !== true, { forward: true });
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
    mainWindowRef?.webContents.send("toast:clicked", id);
  }
});

// The incoming-call card's Accept/Decline — routed to the MAIN window renderer,
// where the runtime answers the call machine (same relay shape as card clicks).
ipcMain.on("space-toast:callAction", (_event, action: unknown) => {
  if (action === "accept" || action === "decline") {
    mainWindowRef?.webContents.send("toast:callAction", action);
  }
});

// A voice-invite card's Join/Dismiss — the same main-window relay by card id.
ipcMain.on("space-toast:voiceInviteAction", (_event, action: unknown, id: unknown) => {
  if ((action === "join" || action === "dismiss") && typeof id === "number") {
    mainWindowRef?.webContents.send("toast:voiceInviteAction", action, id);
  }
});

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 693,
    title: "space",
    frame: false, // oak's borderless chrome — the renderer draws the caption bar
    backgroundColor: "#1e1f22",
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
    toastWindow?.close();
    popoutWindow?.close();
  });

  // Graceful close (live report 2026-09-25): closing the app while in a voice
  // room left PHANTOM tiles for ~a minute — the server drops the voice member
  // on the WS cut, but JANUS keeps the dead publisher session until its own
  // timeout. The first close is forestalled ~900ms while the renderer leaves
  // the room explicitly (voice.leave STOMP + Janus destroy HTTP) — the peers'
  // tiles drop instantly. A hard kill (crash/taskkill) still pays the Janus
  // timeout: nothing client-side survives that.
  let closeDeferred = false;
  mainWindow.on("close", (event) => {
    if (closeDeferred || mainWindow.webContents.isDestroyed()) {
      return;
    }
    closeDeferred = true;
    event.preventDefault();
    mainWindow.webContents.send("app:closing");
    setTimeout(() => mainWindow.close(), 900);
  });

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

app.whenReady().then(() => {
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

// OS-wide chords must die with the app — nothing else frees them.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
