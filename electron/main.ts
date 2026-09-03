import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } from "electron";
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
