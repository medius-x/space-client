import { app, BrowserWindow, contentTracing, desktopCapturer, dialog, ipcMain, net, screen, session, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Space spike — Electron main process.
 *
 * Deliberately thin: the whole protocol stack (REST/STOMP/Janus/WebRTC) lives in the
 * renderer (server CORS is wide open), so main only owns the window, the display-media
 * grant, and the security posture. DevTools stays open — this is a diagnostics spike.
 */

// Autoplay: the documented default is no-user-gesture-required but real-world reports
// disagree — set it both here and on the window below, and the renderer also calls
// audioContext.resume() from the login click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

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
const logFilePath = path.join(app.getPath("userData"), "space.log");
function appendLog(line: string): void {
  try {
    fs.appendFileSync(logFilePath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never take the app down
  }
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

ipcMain.handle("space-cache:put", (_event, key: unknown, bytes: unknown) => {
  if (typeof key !== "string" || !(bytes instanceof Uint8Array)) {
    return false;
  }
  try {
    fs.writeFileSync(cachePath(key), bytes);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("space-cache:get", (_event, key: unknown) => {
  if (typeof key !== "string") {
    return null;
  }
  try {
    const bytes = fs.readFileSync(cachePath(key));
    // touch for LRU
    fs.utimesSync(cachePath(key), new Date(), new Date());
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle("space-cache:trim", (_event, maxBytes: unknown) => {
  const budget = typeof maxBytes === "number" ? maxBytes : 256 * 1024 * 1024;
  try {
    const dir = cacheDir();
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((left, right) => left.mtime - right.mtime); // oldest first
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= budget) {
        break;
      }
      try {
        fs.unlinkSync(entry.full);
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

/** Caption-bar window controls (borderless chrome, oak parity). */
ipcMain.on("space-window:minimize", () => mainWindowRef?.minimize());
ipcMain.on("space-window:maximize", () => {
  if (mainWindowRef?.isMaximized()) {
    mainWindowRef.unmaximize();
  } else {
    mainWindowRef?.maximize();
  }
});
ipcMain.on("space-window:close", () => mainWindowRef?.close());

ipcMain.handle("space-capture:sources", async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
      thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    }));
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

// ---------------------------------------------------------------------------
// Share pop-out window (M4): a separate BrowserWindow fed with JPEG frames from
// the main window over IPC (MediaStream objects cannot cross renderer contexts).
// ---------------------------------------------------------------------------

let popoutWindow: BrowserWindow | null = null;
let mainWindowRef: BrowserWindow | null = null;

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
    title: "space — screen share",
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
  popoutWindow = popout;
  popout.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popout.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "file://")) {
      event.preventDefault();
    }
  });
  popout.on("closed", () => {
    popoutWindow = null;
    mainWindowRef?.webContents.send("popout:closed");
  });
  void loadRendererTarget(popout, "popout").catch((error: unknown) => {
    appendLog(`[main] popout load failed: ${error instanceof Error ? error.message : String(error)}`);
    popout.close();
  });
  return true;
});

ipcMain.on("popout:frame", (_event, dataUrl: unknown) => {
  if (typeof dataUrl === "string" && popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send("popout:frame", dataUrl);
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
  // The caption's maximize glyph flips on restore (oak's ▢↔❐).
  mainWindow.on("maximize", () => mainWindow.webContents.send("space-window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("space-window:maximized", false));

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
    desktopCapturer
      .getSources({ types: grant ? ["screen", "window"] : ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        let chosen = grant ? sources.find((source) => source.id === grant.sourceId) : undefined;
        if (!chosen) {
          const primaryId = String(screen.getPrimaryDisplay().id);
          chosen = sources.find((source) => source.display_id === primaryId) ?? sources[0];
        }
        if (!chosen) {
          appendLog("[main] ERROR display-media: no sources available");
          callback({});
          return;
        }
        const withLoopback = (grant?.withAudio ?? false) && request.audioRequested;
        appendLog(`[main] display-media grant: ${chosen.id} audio=${withLoopback ? "loopback" : "none"}`);
        callback({ video: chosen, audio: withLoopback ? "loopback" : undefined });
      })
      .catch((error: unknown) => {
        appendLog(`[main] ERROR display-media failed: ${error instanceof Error ? error.message : String(error)}`);
        callback({});
      });
  });

  // DevTools are OPT-IN (SPACE_DEVTOOLS=1 npm run dev) — the default window must
  // look exactly like what a user ships with (live M7 polish round).
  if (process.env.SPACE_DEVTOOLS === "1") {
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
  void createWindow();
  app.on("activate", () => {
    // macOS habit — harmless on Windows, kept for free.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
