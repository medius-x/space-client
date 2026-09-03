import { contextBridge, ipcRenderer } from "electron";

/**
 * The preload bridge: appInfo proves contextIsolation works; spaceLog carries renderer
 * log lines to the main process, which appends them to the per-instance log file (the
 * renderer is sandboxed and must not touch the filesystem itself).
 */
contextBridge.exposeInMainWorld("spaceApp", {
  version: process.env.npm_package_version ?? "0.0.0-spike",
  platform: process.platform,
});

contextBridge.exposeInMainWorld("spaceLog", {
  write(line: string): void {
    ipcRenderer.send("space-log", line);
  },
});
