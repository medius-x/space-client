import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Build orchestration: main + preload (CJS, sandboxed preload cannot be ESM) + the
 * React renderer with Fast Refresh. Entries point at the existing files — the tool
 * does not force any file moves. Sessions/media live in module singletons OUTSIDE the
 * React tree so component HMR never tears down WebRTC/STOMP (core edits cost a full
 * reload, same as the spike's esbuild loop).
 */
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, "electron/main.ts") },
      // koffi is a NATIVE module — it must stay external and resolve from
      // node_modules at runtime (bundling a .node addon is impossible).
      rollupOptions: { external: ["electron", "koffi"] },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, "electron/preload.ts") },
      rollupOptions: { external: ["electron"] },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
