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

/** Cross-origin fetch bridge for OG link previews (M7, oak's LinkPreviewService):
 *  the renderer's own fetch is CORS-bound, the main process net stack is not. */
contextBridge.exposeInMainWorld("spaceNet", {
  fetchText(url: string): Promise<{ finalUrl: string; contentType: string; data: Uint8Array } | null> {
    return ipcRenderer.invoke("space-net:fetch", url, "text");
  },
  fetchImage(url: string): Promise<{ finalUrl: string; contentType: string; data: Uint8Array } | null> {
    return ipcRenderer.invoke("space-net:fetch", url, "image");
  },
});

/** Toast-window bridge (oak's NotificationToast): the MAIN window sends cards,
 *  the TOAST window reports clicks/geometry and receives them. */
contextBridge.exposeInMainWorld("spaceToast", {
  show(payload: Record<string, unknown>): void {
    ipcRenderer.send("space-toast:show", payload);
  },
  /** A card was clicked — main relays it back to the MAIN window renderer. */
  clicked(id: number): void {
    ipcRenderer.send("space-toast:clicked", id);
  },
  /** The call card's Accept/Decline — main relays to the MAIN window renderer. */
  callAction(action: "accept" | "decline"): void {
    ipcRenderer.send("space-toast:callAction", action);
  },
  /** True while the cursor is over actual content — the window accepts clicks. */
  hover(interactive: boolean): void {
    ipcRenderer.send("space-toast:hover", interactive);
  },
  /** The stack's real rendered height — main resizes the window (bottom anchored). */
  geometry(contentHeight: number): void {
    ipcRenderer.send("space-toast:geometry", contentHeight);
  },
  /** No cards left — main hides the window. */
  empty(): void {
    ipcRenderer.send("space-toast:empty");
  },
  /** The toast page's subscription is up — main flushes the buffered cards. */
  ready(): void {
    ipcRenderer.send("space-toast:ready");
  },
  onShow(callback: (payload: unknown) => void): void {
    // Single-subscriber channel: replace any previous listener — a remount
    // (HMR, StrictMode) must not stack a second one and duplicate cards.
    ipcRenderer.removeAllListeners("toast:show");
    ipcRenderer.on("toast:show", (_event, payload: unknown) => callback(payload));
  },
  onClicked(callback: (id: number) => void): void {
    ipcRenderer.removeAllListeners("toast:clicked");
    ipcRenderer.on("toast:clicked", (_event, id: unknown) => {
      if (typeof id === "number") {
        callback(id);
      }
    });
  },
  onCallAction(callback: (action: "accept" | "decline") => void): void {
    ipcRenderer.removeAllListeners("toast:callAction");
    ipcRenderer.on("toast:callAction", (_event, action: unknown) => {
      if (action === "accept" || action === "decline") {
        callback(action);
      }
    });
  },
});

/** Global-hotkey bridge (2026-09-18): the renderer pushes the full global set
 *  (main registers it OS-wide) and receives presses back — a chord fires while
 *  the window has NO focus (mute from a fullscreen game). */
contextBridge.exposeInMainWorld("spaceHotkey", {
  sync(entries: { id: string; accelerator: string }[]): Promise<unknown> {
    return ipcRenderer.invoke("space-hotkey:sync", entries);
  },
  onHotkey(callback: (actionId: string) => void): void {
    // Single-subscriber channel: replace any previous listener — a remount
    // (HMR, StrictMode) must not stack a second one and double-dispatch.
    ipcRenderer.removeAllListeners("space-hotkey:press");
    ipcRenderer.on("space-hotkey:press", (_event, actionId: unknown) => {
      if (typeof actionId === "string") {
        callback(actionId);
      }
    });
  },
});

/** Capture-picker bridge (M4): desktop sources with previews + the grant hint. */
contextBridge.exposeInMainWorld("spaceCapture", {
  /** Optional type filter — e.g. the self-test needs only screens, and skipping
   *  the window enumeration avoids Chromium's WGC "Source is not capturable"
   *  error spam for uncapturable windows (plus most of the startup latency). */
  sources(types?: ("screen" | "window")[]): Promise<unknown> {
    return ipcRenderer.invoke("space-capture:sources", types);
  },
  select(sourceId: string, withAudio: boolean): Promise<unknown> {
    return ipcRenderer.invoke("space-capture:select", sourceId, withAudio);
  },
  /** Arm/cancel the window-share liveness watchdog (null cancels). */
  watchSource(sourceId: string | null): Promise<unknown> {
    return ipcRenderer.invoke("space-capture:watchSource", sourceId);
  },
  /** The watched window died — the renderer stops the share the ordinary way. */
  onSourceDead(callback: (sourceId: string) => void): void {
    ipcRenderer.removeAllListeners("space-capture:sourceDead");
    ipcRenderer.on("space-capture:sourceDead", (_event, sourceId: string) => {
      callback(sourceId);
    });
  },
});

/** Native system-audio bridge (#485): WASAPI process-loopback. Without a
 *  source id the capture is the desktop minus OUR process (screen shares);
 *  a WINDOW source id switches it to that application's own audio. Frames
 *  arrive as Int16Array at the ~10 ms drain cadence. */
contextBridge.exposeInMainWorld("spaceSysAudio", {
  available(): Promise<unknown> {
    return ipcRenderer.invoke("space-sysaudio:available");
  },
  start(sourceId?: string): Promise<unknown> {
    return ipcRenderer.invoke("space-sysaudio:start", sourceId ?? null);
  },
  stop(): Promise<unknown> {
    return ipcRenderer.invoke("space-sysaudio:stop");
  },
  onFrame(callback: (pcm: Int16Array, silent: boolean) => void): void {
    ipcRenderer.removeAllListeners("space-sysaudio:frame");
    ipcRenderer.on("space-sysaudio:frame", (_event, pcm: Int16Array, silent: boolean) => {
      callback(pcm, silent);
    });
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
