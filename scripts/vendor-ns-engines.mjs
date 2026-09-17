/**
 * Vendor the Speex/Gate engine assets from @sapphi-red/web-noise-suppressor
 * into src/renderer/public/ns/ (run `npm run ns:vendor` after every update of
 * that package). The renderer loads them over the space-asset:// protocol and
 * turns the worklet modules into blobs — see noise-suppression.ts for why a
 * bare ?url/file path cannot work under the packaged file:// window.
 * (DTLN's @workadventure assets ride the vite bundle via its own plugin —
 * nothing to vendor here.)
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = join(scriptDir, "..", "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const target = join(scriptDir, "..", "src", "renderer", "public", "ns");

mkdirSync(target, { recursive: true });
const files = [
  ["speex/workletProcessor.js", "speexWorklet.js"],
  ["speex.wasm", "speex.wasm"],
  ["noiseGate/workletProcessor.js", "noiseGateWorklet.js"],
];
for (const [from, to] of files) {
  copyFileSync(join(source, from), join(target, to));
  console.log(`vendored ${from} → ns/${to}`);
}
