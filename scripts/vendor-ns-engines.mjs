/**
 * Vendor the noise-engine assets into src/renderer/public/ns/ (run
 * `npm run ns:vendor` after every update of either package). The renderer
 * loads them over the space-asset:// protocol and turns the worklet modules
 * into blobs — see noise-suppression.ts for why a bare ?url/file path cannot
 * work under the packaged file:// window.
 *
 * DTLN (@workadventure/noise-suppression): their audio-worklet-processor.js
 * is a SELF-CONTAINED 5.8 MB bundle — both tflite models ride inside it as
 * base64 — so only the processor file and the RELAXED-SIMD litert wasm binary
 * are vendored (the compat/jspi/threaded wasm variants are browser fallbacks
 * this Electron Chromium never needs; the variant is picked via
 * processorOptions.liteRtVariant in noise-suppression.ts).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = join(scriptDir, "..", "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const dtlnSource = join(scriptDir, "..", "node_modules", "@workadventure", "noise-suppression", "dist");
const target = join(scriptDir, "..", "src", "renderer", "public", "ns");

mkdirSync(join(target, "dtln"), { recursive: true });
const files = [
  [source, "speex/workletProcessor.js", "speexWorklet.js"],
  [source, "speex.wasm", "speex.wasm"],
  [source, "noiseGate/workletProcessor.js", "noiseGateWorklet.js"],
  [dtlnSource, "assets/audio-worklet-processor.js", "dtln/workletProcessor.js"],
  [dtlnSource, "vendor/litert/litert_wasm_internal.wasm", "dtln/litert_wasm_internal.wasm"],
];
for (const [root, from, to] of files) {
  copyFileSync(join(root, from), join(target, to));
  console.log(`vendored ${from} → ns/${to}`);
}
