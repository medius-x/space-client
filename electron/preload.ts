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

/** KV persistence bridge: declarative mutations executed under the main-process lock. */
contextBridge.exposeInMainWorld("spaceKv", {
  get(key: string): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:get", key);
  },
  set(key: string, value: unknown): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:set", key, value);
  },
  merge(key: string, partial: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:merge", key, partial);
  },
  rotateTokens(key: string, expectedRefreshToken: string, tokens: { token: string; refreshToken: string; expiresAt: number }): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:rotate-tokens", key, expectedRefreshToken, tokens);
  },
  delete(key: string): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:delete", key);
  },
  keys(prefix: string): Promise<unknown> {
    return ipcRenderer.invoke("space-kv:keys", prefix);
  },
});

/** Media bridges: disk image cache (by stable key), system browser, save dialog. */
contextBridge.exposeInMainWorld("spaceMedia", {
  cachePut(key: string, bytes: Uint8Array): Promise<unknown> {
    return ipcRenderer.invoke("space-cache:put", key, bytes);
  },
  cacheGet(key: string): Promise<unknown> {
    return ipcRenderer.invoke("space-cache:get", key);
  },
  cacheTrim(maxBytes: number): Promise<unknown> {
    return ipcRenderer.invoke("space-cache:trim", maxBytes);
  },
  openExternal(url: string): Promise<unknown> {
    return ipcRenderer.invoke("space-shell:openExternal", url);
  },
  saveFile(fileName: string, bytes: Uint8Array): Promise<unknown> {
    return ipcRenderer.invoke("space-file:save", fileName, bytes);
  },
});

/** Capture-picker bridge (M4): desktop sources with previews + the grant hint. */
contextBridge.exposeInMainWorld("spaceCapture", {
  sources(): Promise<unknown> {
    return ipcRenderer.invoke("space-capture:sources");
  },
  select(sourceId: string, withAudio: boolean): Promise<unknown> {
    return ipcRenderer.invoke("space-capture:select", sourceId, withAudio);
  },
});

/** Share pop-out bridge (M4) + the caption-bar controls of the borderless main
 *  window (oak chrome): min/max/close and the maximize-glyph flip. */
contextBridge.exposeInMainWorld("spaceWindow", {
  openPopout(): Promise<unknown> {
    return ipcRenderer.invoke("space-window:popout");
  },
  sendFrame(dataUrl: string): void {
    ipcRenderer.send("popout:frame", dataUrl);
  },
  onFrame(callback: (dataUrl: string) => void): void {
    ipcRenderer.on("popout:frame", (_event, dataUrl: unknown) => {
      if (typeof dataUrl === "string") {
        callback(dataUrl);
      }
    });
  },
  onClosed(callback: () => void): void {
    ipcRenderer.on("popout:closed", () => callback());
  },
  minimize(): void {
    ipcRenderer.send("space-window:minimize");
  },
  toggleMaximize(): void {
    ipcRenderer.send("space-window:maximize");
  },
  close(): void {
    ipcRenderer.send("space-window:close");
  },
  onMaximizedChange(callback: (maximized: boolean) => void): void {
    ipcRenderer.on("space-window:maximized", (_event, maximized: unknown) => {
      if (typeof maximized === "boolean") {
        callback(maximized);
      }
    });
  },
});
