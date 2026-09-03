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
