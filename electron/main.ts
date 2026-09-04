import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell } from "electron";
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

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "space",
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

  // Security: this spike never navigates anywhere except its own local page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  // Display media: auto-grant the primary display + system audio loopback (Windows).
  // The spike deliberately has no picker — the goal is to probe the 'loopback' path,
  // not to build UX. request.audioRequested is honored only when the renderer asked.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id);
        const chosen = sources.find((source) => source.display_id === primaryId) ?? sources[0];
        if (!chosen) {
          appendLog("[main] ERROR display-media: no screen sources available");
          callback({});
          return;
        }
        appendLog(`[main] display-media grant: ${chosen.id} audio=${request.audioRequested}`);
        callback({ video: chosen, audio: request.audioRequested ? "loopback" : undefined });
      })
      .catch((error: unknown) => {
        appendLog(`[main] ERROR display-media failed: ${error instanceof Error ? error.message : String(error)}`);
        callback({});
      });
  });

  mainWindow.webContents.openDevTools({ mode: "bottom" });
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
