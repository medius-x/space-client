// LAZY-CHUNKED: the "sync" glue inlines the whole wasm as base64 (~1.9 MB of
// string) — importing it statically would bloat the main bundle. The dynamic
// ?raw import keeps it a separate chunk that loads when an engine boots
// (typed by the "*?raw" module declaration in src/vite-raw.d.ts).

import { log } from "../logging";

/**
 * The microphone noise-suppression pipeline (user decision 2026-09-17): a
 * WebAudio detour between getUserMedia and the published track —
 *
 *   raw mic track → MediaStreamSource → [engine worklet] → MediaStreamDestination → processed track
 *
 * Chromium's capture-side AEC/AGC stay ALWAYS ON (they process before WebAudio
 * ever sees a sample — echo hurts the OTHER listeners, so there is no knob),
 * while the built-in noiseSuppression constraint is ALWAYS OFF: its job belongs
 * to the selectable engine, and stacking two suppressors mangles speech.
 *
 * The engines share this integration shape, so switching is uniform:
 *  - RNNoise  — @jitsi/rnnoise-wasm "sync" build (wasm inlined as base64,
 *    designed for AudioWorklets), our own processor with the framing pinned by
 *    domain/logic/rnnoise-framing tests;
 *  - DeepFilterNet3 — the deepfilternet3-noise-filter package, LAZY-imported so
 *    its heavy assets load only when the engine is selected. The package fetches
 *    its wasm + ONNX model from a CDN by default — unacceptable for a
 *    self-hosted/offline app — so both files are vendored into
 *    src/renderer/public/df3/ and cdnUrl points at the local copies;
 *  - Speex/Gate — @sapphi-red/web-noise-suppressor worklets, vendored via
 *    scripts/vendor-ns-engines.mjs;
 *  - DTLN — @workadventure/noise-suppression. Their 5.8 MB worklet processor
 *    is SELF-CONTAINED (both tflite models inlined as base64) and speaks an
 *    honest ready/error handshake; the ONLY external asset is the litert wasm
 *    binary, passed through processorOptions (their wrapper's URL resolution
 *    is what made the first integration attempt impossible under file://).
 */
export type NoiseEngineKind = "off" | "rnnoise" | "deepfilternet3" | "speex" | "gate" | "dtln";

/** The audio rate every engine path is built around (RNNoise's 480-sample frame
 *  is 10 ms at 48 kHz; the capture constraints request the same rate). */
export const NOISE_PIPELINE_SAMPLE_RATE = 48000;

export interface NoisePipeline {
  readonly engine: NoiseEngineKind;
  /** The processed track to publish; the RAW track stays owned by the caller. */
  readonly track: MediaStreamTrack;
  /** Last VAD probability reported by the engine (diagnostics only). */
  readonly vad: number | null;
  /** DeepFilterNet3 only: its 0–100 dB suppression limit, applied live. */
  setSuppressionLevel?(level: number): void;
  /** Tear the WebAudio detour down; does NOT stop the raw track. */
  dispose(): void;
}

/** The default DFN3 level rides the engine's own native scale: 50 dB of
 *  allowed attenuation is effectively "no limit" for it. */
export const DEFAULT_DEEP_FILTER_LEVEL = 50;

/**
 * Boot an AudioContext and REFUSE to hand back one that cannot run. A context
 * stuck "suspended" still loads the worklet module and runs its constructor
 * (the dfn3/dtln ready-handshake fires from there), so the logs read "engine
 * live" while process() is never called and the published track delivers
 * silence forever — no error anywhere (live bug 2026-10-16: cycling engines
 * exhausted the browser's context slots; every later boot came up suspended
 * and the uplink died until a room re-join). Throwing here makes the caller's
 * existing catch publish the RAW mic instead — degraded, but audible.
 */
async function bootPipelineContext(sampleRate: number): Promise<AudioContext> {
  const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
  if (context.state === "suspended") {
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        context.resume(),
        new Promise<void>((resolve) => {
          resumeTimer = setTimeout(resolve, 3_000);
        }),
      ]);
    } catch {
      // resume() rejected — the state check below decides
    } finally {
      if (resumeTimer !== undefined) {
        clearTimeout(resumeTimer);
      }
    }
  }
  if (context.state !== "running") {
    void context.close();
    throw new Error(`AudioContext stayed "${context.state}" — the engine cannot run in this window`);
  }
  return context;
}

export async function createNoisePipeline(
  engine: NoiseEngineKind,
  rawTrack: MediaStreamTrack,
  deepFilterLevel: number = DEFAULT_DEEP_FILTER_LEVEL,
): Promise<NoisePipeline> {
  if (engine === "rnnoise") {
    return createRnnoisePipeline(rawTrack);
  }
  if (engine === "speex") {
    return createSpeexPipeline(rawTrack);
  }
  if (engine === "gate") {
    return createGatePipeline(rawTrack);
  }
  if (engine === "dtln") {
    return createDtlnPipeline(rawTrack);
  }
  return createDeepFilterPipeline(rawTrack, deepFilterLevel);
}

// ---------------------------------------------------------------------------
// RNNoise
// ---------------------------------------------------------------------------

/**
 * The AudioWorklet processor source. A worklet module cannot import app code,
 * so the ring-buffer semantics are a verbatim copy of
 * domain/logic/rnnoise-framing.ts — KEEP THEM IN SYNC (the tests pin the
 * contract: exact 480-sample frames, constant one-frame output lag, a priming
 * silent frame so 480 % 128 never starves the output).
 */
const RNNOISE_PROCESSOR_SOURCE = `
const RNNOISE_FRAME = 480;
const RING_SIZE = 1920;

class SpaceRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRing = new Float32Array(RING_SIZE);
    this.inputLength = 0;
    this.outputRing = new Float32Array(RING_SIZE);
    this.outputLength = RNNOISE_FRAME; // the priming silent frame (zero-filled)
    this.ready = false;
    this.frameCount = 0;
    this.boot().catch(() => {
      // A failed wasm boot leaves the processor a passthrough — audio always flows.
    });
  }

  async boot() {
    this.module = createRNNWasmModuleSync();
    await this.module.ready;
    this.contextPtr = this.module._rnnoise_create();
    this.pcmPtr = this.module._malloc(RNNOISE_FRAME * 4);
    this.pcmIndex = this.pcmPtr >> 2;
    this.ready = true;
  }

  process(inputs, outputs) {
    const input = inputs.length > 0 && inputs[0].length > 0 ? inputs[0][0] : null;
    const output = outputs.length > 0 && outputs[0].length > 0 ? outputs[0][0] : null;
    if (output === null || output === undefined) {
      return true;
    }
    if (input === null || input === undefined) {
      output.fill(0);
      return true;
    }
    if (!this.ready) {
      output.set(input); // pre-boot: raw passthrough
      return true;
    }
    // Push the quantum into the input ring (drop on overflow — invariant break).
    if (this.inputLength + input.length <= RING_SIZE) {
      this.inputRing.set(input, this.inputLength);
      this.inputLength += input.length;
    }
    while (this.inputLength >= RNNOISE_FRAME && this.outputLength + RNNOISE_FRAME <= RING_SIZE) {
      const pcmIndex = this.pcmIndex;
      const heap = this.module.HEAPF32;
      for (let sampleIndex = 0; sampleIndex < RNNOISE_FRAME; sampleIndex += 1) {
        heap[pcmIndex + sampleIndex] = this.inputRing[sampleIndex] * 32768;
      }
      const vad = this.module._rnnoise_process_frame(this.contextPtr, this.pcmPtr, this.pcmPtr);
      for (let sampleIndex = 0; sampleIndex < RNNOISE_FRAME; sampleIndex += 1) {
        this.outputRing[this.outputLength + sampleIndex] = heap[pcmIndex + sampleIndex] / 32768;
      }
      this.outputLength += RNNOISE_FRAME;
      this.inputRing.copyWithin(0, RNNOISE_FRAME, this.inputLength);
      this.inputLength -= RNNOISE_FRAME;
      this.frameCount += 1;
      if (this.frameCount % 50 === 0) {
        this.port.postMessage({ type: "vad", value: vad });
      }
    }
    const copied = Math.min(output.length, this.outputLength);
    output.set(this.outputRing.subarray(0, copied));
    if (copied < output.length) {
      output.fill(0, copied);
    }
    this.outputRing.copyWithin(0, copied, this.outputLength);
    this.outputLength -= copied;
    return true;
  }
}

registerProcessor("space-rnnoise", SpaceRnnoiseProcessor);
`;

async function createRnnoisePipeline(rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  const context = await bootPipelineContext(NOISE_PIPELINE_SAMPLE_RATE);
  // The emscripten glue is an ES module exporting the sync factory; the
  // processor source rides behind it in ONE blob — addModule needs a URL and
  // the ?raw dynamic import keeps the base64-wasm payload off the main bundle.
  const glueModule = await import("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js?raw");
  const rnnoiseSyncModuleSource = glueModule.default;
  const workletUrl = URL.createObjectURL(
    new Blob([`${rnnoiseSyncModuleSource}\n${RNNOISE_PROCESSOR_SOURCE}`], { type: "text/javascript" }),
  );
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const node = new AudioWorkletNode(context, "space-rnnoise", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  const pipeline: NoisePipeline = {
    engine: "rnnoise",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    dispose(): void {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      void context.close();
    },
  };
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; value?: number } | undefined;
    if (data !== undefined && data.type === "vad" && typeof data.value === "number") {
      (pipeline as { vad: number | null }).vad = data.value;
    }
  };
  return pipeline;
}

// ---------------------------------------------------------------------------
// DeepFilterNet3 (lazy — the assets load only when the engine is chosen)
// ---------------------------------------------------------------------------

/**
 * OUR processor, appended INSIDE the package's worklet IIFE (its wasm-bindgen
 * glue — initSync/df_create/df_process_frame/df_set_atten_lim — is in scope
 * there). The package's own processor SWALLOWS its boot errors into a silent
 * passthrough (a live-caught defect: identical inputs, out == in, "live" in
 * the log) — ours reports ready/error over the port and never fakes success.
 * Framing mirrors the RNNoise processor: fixed frames, a priming silent frame,
 * passthrough only before a successful boot.
 */
const DFN3_PROCESSOR_SOURCE = `
class SpaceDfn3Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.inputRing = null;
    this.outputRing = null;
    this.inputLength = 0;
    this.outputLength = 0;
    this.frame = null;
    const describe = (error) => String((error && error.message) || error)
      + ((error && error.stack) ? ' | ' + String(error.stack).split('\\n').slice(1, 3).join(' ~ ') : '');
    try {
      initSync(options.processorOptions.wasmModule);
    } catch (error) {
      this.port.postMessage({ type: 'error', message: 'initSync: ' + describe(error) });
      return;
    }
    const modelBytes = options.processorOptions.modelBytes;
    if (!(modelBytes instanceof Uint8Array) || modelBytes.length < 1000) {
      this.port.postMessage({ type: 'error', message: 'model bytes bad: ' + (modelBytes && modelBytes.constructor && modelBytes.constructor.name) + ' len=' + (modelBytes && modelBytes.length) });
      return;
    }
    try {
      this.handle = df_create(modelBytes, options.processorOptions.suppressionLevel ?? 50);
    } catch (error) {
      this.port.postMessage({ type: 'error', message: 'df_create(' + modelBytes.length + ' bytes): ' + describe(error) });
      return;
    }
    try {
      this.frameLength = df_get_frame_length(this.handle);
      if (!(this.frameLength > 0)) {
        throw new Error('df frame length ' + this.frameLength);
      }
      const ringSize = this.frameLength * 4;
      this.inputRing = new Float32Array(ringSize);
      this.outputRing = new Float32Array(ringSize);
      this.outputLength = this.frameLength; // the priming silent frame (zero-filled)
      this.frame = new Float32Array(this.frameLength);
      this.ready = true;
      this.port.onmessage = (event) => {
        const data = event.data;
        if (this.ready && data !== undefined && data.type === 'level' && typeof data.value === 'number' && this.handle !== undefined) {
          df_set_atten_lim(this.handle, Math.max(0, Math.min(100, data.value)));
        }
      };
      this.port.postMessage({ type: 'ready', frameLength: this.frameLength });
    } catch (error) {
      this.port.postMessage({ type: 'error', message: 'frame setup: ' + describe(error) });
    }
  }

  process(inputs, outputs) {
    const input = inputs.length > 0 && inputs[0].length > 0 ? inputs[0][0] : null;
    const output = outputs.length > 0 && outputs[0].length > 0 ? outputs[0][0] : null;
    if (output === null || output === undefined) {
      return true;
    }
    if (input === null || input === undefined) {
      output.fill(0);
      return true;
    }
    if (!this.ready) {
      output.set(input);
      return true;
    }
    if (this.inputLength + input.length <= this.inputRing.length) {
      this.inputRing.set(input, this.inputLength);
      this.inputLength += input.length;
    }
    while (this.inputLength >= this.frameLength && this.outputLength + this.frameLength <= this.outputRing.length) {
      this.frame.set(this.inputRing.subarray(0, this.frameLength));
      let processed = null;
      try {
        processed = df_process_frame(this.handle, this.frame);
      } catch (error) {
        this.ready = false;
        this.port.postMessage({ type: 'error', message: 'df_process_frame: ' + String((error && error.message) || error) });
        output.set(input);
        return true;
      }
      if (processed === null || processed === undefined || processed.length !== this.frameLength) {
        this.ready = false;
        this.port.postMessage({ type: 'error', message: 'df_process_frame returned ' + (processed && processed.length) + ' samples (expected ' + this.frameLength + ')' });
        output.set(input);
        return true;
      }
      this.outputRing.set(processed, this.outputLength);
      this.outputLength += this.frameLength;
      this.inputRing.copyWithin(0, this.frameLength, this.inputLength);
      this.inputLength -= this.frameLength;
    }
    const copied = Math.min(output.length, this.outputLength);
    output.set(this.outputRing.subarray(0, copied));
    if (copied < output.length) {
      output.fill(0, copied);
    }
    this.outputRing.copyWithin(0, copied, this.outputLength);
    this.outputLength -= copied;
    return true;
  }
}

registerProcessor('space-dfn3', SpaceDfn3Processor);
`;

/** The glue is VENDORED (scripts/extract-df3-glue.mjs, `npm run df3:glue`) as
 *  a plain string module: the package's exports map blocks deep imports, and a
 *  ?raw-FILE import of a project file outside the renderer root is not
 *  rewritten by the vite dev analyzer (it falls through to the SPA html — a
 *  live-caught blob syntax error). The string is the package's IIFE PREFIX
 *  with the wasm-bindgen df functions; our processor is appended inside it. */
async function loadDfn3GlueSource(): Promise<string> {
  const glueModule = await import("./df3-glue");
  return glueModule.default;
}

async function createDeepFilterPipeline(rawTrack: MediaStreamTrack, suppressionLevel: number): Promise<NoisePipeline> {
  // NOTE the DOUBLE closing brace: the first `}` closes the ${...} interpolation,
  // the second is the literal IIFE closer. A single one silently produces
  // `...registerProcessor(...);)();` — "Unexpected token ')'" (live-caught).
  const moduleSource = `${await loadDfn3GlueSource()}${DFN3_PROCESSOR_SOURCE}})();\n`;
  // Vendored assets (src/renderer/public/df3) instead of the package's CDN —
  // the app must work offline and never phone home for models.
  const [wasmBytes, modelBytes] = await Promise.all([
    fetchAsset("df3/v3/pkg/df_bg.wasm"),
    // .bin, NOT .tar.gz: a .gz static is served with Content-Encoding: gzip,
    // and the browser's fetch TRANSPARENTLY decompresses it — df_create then
    // gets the raw tar (8601600 bytes instead of 7983136) and panics with an
    // "unreachable" wasm trap (live-caught). The body stays gzip either way:
    // df_create unpacks it itself.
    fetchAsset("df3/v3/models/DeepFilterNet3_onnx.bin"),
  ]);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const context = await bootPipelineContext(NOISE_PIPELINE_SAMPLE_RATE);
  const workletUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  log.info("ns", `dfn3 boot assets: wasm=${wasmBytes.byteLength} model=${modelBytes.byteLength}`);
  const node = new AudioWorkletNode(context, "space-dfn3", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { wasmModule, modelBytes: new Uint8Array(modelBytes), suppressionLevel },
  });
  // A firm handshake: the worklet MUST answer ready or error. Never a silent
  // passthrough (the package's defect) — a boot failure throws here, the
  // caller falls back to the raw mic and the cause lands in the log.
  const boot = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const timeout = window.setTimeout(() => resolve({ ok: false, detail: "worklet boot timeout (10 s)" }), 10_000);
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; message?: string; frameLength?: number } | undefined;
      if (data === undefined) {
        return;
      }
      if (data.type === "ready") {
        window.clearTimeout(timeout);
        resolve({ ok: true, detail: `frame ${data.frameLength ?? "?"}` });
      } else if (data.type === "error") {
        window.clearTimeout(timeout);
        resolve({ ok: false, detail: data.message ?? "unknown worklet error" });
      }
    };
  });
  if (!boot.ok) {
    node.port.onmessage = null;
    node.disconnect();
    void context.close();
    throw new Error(`DeepFilterNet3 worklet failed to boot: ${boot.detail}`);
  }
  log.info("ns", `dfn3 worklet ready (${boot.detail})`);
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; message?: string } | undefined;
    if (data !== undefined && data.type === "error") {
      log.error("ns", `dfn3 worklet died mid-stream: ${data.message ?? "?"} (publishing continues raw)`);
    }
  };
  return {
    engine: "deepfilternet3",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    setSuppressionLevel(level: number): void {
      node.port.postMessage({ type: "level", value: level }); // → df_set_atten_lim, live
    },
    dispose(): void {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      void context.close();
    },
  };
}

/** Engine assets ride main's read-only space-asset:// protocol: the packaged
 *  window is a file:// document and CANNOT fetch its own files (CORS origin
 *  null) — relative URLs only work under the vite dev server. */
const ASSET_BASE = "space-asset://";

async function fetchAsset(relative: string): Promise<ArrayBuffer> {
  const response = await fetch(ASSET_BASE + relative);
  if (!response.ok) {
    throw new Error(`asset ${relative} fetch: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function fetchAssetText(relative: string): Promise<string> {
  const response = await fetch(ASSET_BASE + relative);
  if (!response.ok) {
    throw new Error(`asset ${relative} fetch: ${response.status}`);
  }
  return response.text();
}

/** Load a vendored worklet MODULE as a blob (addModule needs a URL; blob URLs
 *  behave identically under dev and the packaged file:// window). */
async function addWorkletModule(context: AudioContext, relative: string): Promise<void> {
  const text = await fetchAssetText(relative);
  const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// ---------------------------------------------------------------------------
// Speex (the speexdsp "preprocess" classic; @sapphi-red's wasm build) and the
// noise Gate from the same package (user decision 2026-09-17: more choice,
// vendored via scripts/vendor-ns-engines.mjs / `npm run ns:vendor`).
// ---------------------------------------------------------------------------

async function createSpeexPipeline(rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  const { SpeexWorkletNode, loadSpeex } = await import("@sapphi-red/web-noise-suppressor");
  const context = await bootPipelineContext(NOISE_PIPELINE_SAMPLE_RATE);
  // addModule ON THE PIPELINE'S OWN CONTEXT: Chromium keeps the worklet module
  // map PER CONTEXT — registering on a throwaway carrier (the earlier cache)
  // left this context without the processor ("no valid AudioWorkletGlobalScope",
  // live report). Per-context also means no "already registered" clashes.
  const wasmBinary = await loadSpeex({ url: `${ASSET_BASE}ns/speex.wasm` });
  await addWorkletModule(context, "ns/speexWorklet.js");
  const node = new SpeexWorkletNode(context, { maxChannels: 1, wasmBinary });
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  return {
    engine: "speex",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    dispose(): void {
      node.destroy();
      source.disconnect();
      void context.close();
    },
  };
}

async function createGatePipeline(rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  const { NoiseGateWorkletNode } = await import("@sapphi-red/web-noise-suppressor");
  const context = await bootPipelineContext(NOISE_PIPELINE_SAMPLE_RATE);
  await addWorkletModule(context, "ns/noiseGateWorklet.js"); // per-context, see createSpeexPipeline
  // Speech-level defaults: open at −45 dBFS, close at −60, hold 250 ms — quiet
  // background stays out, normal talking keeps the gate open.
  const node = new NoiseGateWorkletNode(context, {
    openThreshold: -45,
    closeThreshold: -60,
    holdMs: 250,
    maxChannels: 1,
  });
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  return {
    engine: "gate",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    dispose(): void {
      source.disconnect();
      node.disconnect();
      void context.close();
    },
  };
}

// ---------------------------------------------------------------------------
// DTLN (@workadventure/noise-suppression) — the packaged processor IS the
// engine: a self-contained rolldown IIFE (registerProcessor at the tail) with
// BOTH tflite models inlined as base64 and the litert emscripten factories in
// scope. The earlier rejection of this package was about its WRAPPER, which
// resolves the wasm/models via URL fetches that die under a file:// document;
// we bypass the wrapper entirely and hand the one external asset — the
// relaxed-SIMD litert wasm — to the processor as processorOptions bytes.
// ---------------------------------------------------------------------------

/** DTLN's native rate: the model eats fixed 512-sample frames (32 ms) at
 *  16 kHz. Their processor has NO resampler, so the pipeline context itself
 *  runs at 16 kHz — Chromium resamples the 48k mic at the MediaStreamSource,
 *  and the PUBLISHED track comes out wideband 16k mono (intrinsic to DTLN,
 *  Opus carries it fine). 512 = 4×128, so the render quantum divides the
 *  frame exactly — no priming tricks needed (their ring buffer accumulates
 *  quanta into frames and silences the few startup quanta). */
const DTLN_PIPELINE_SAMPLE_RATE = 16000;

/** The processor's registered name (NOISE_SUPPRESSION_AUDIO_WORKLET_PROCESSOR
 *  of the package's audio-worklet-shared). */
const DTLN_PROCESSOR_NAME = "workadventure-noise-suppression";

/** ~14.6 MB of assets ride every boot — cache them across engine switches
 *  (a live rebuild refetching the pair each toggle would be wasteful; the
 *  bytes are only ever structured-CLONED into the worklet, never transferred). */
let dtlnAssets: { processorText: string; wasmBinary: ArrayBuffer } | null = null;

async function loadDtlnAssets(): Promise<{ processorText: string; wasmBinary: ArrayBuffer }> {
  if (dtlnAssets === null) {
    const [processorText, wasmBinary] = await Promise.all([
      fetchAssetText("ns/dtln/workletProcessor.js"),
      fetchAsset("ns/dtln/litert_wasm_internal.wasm"),
    ]);
    dtlnAssets = { processorText, wasmBinary };
  }
  return dtlnAssets;
}

async function createDtlnPipeline(rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  const { processorText, wasmBinary } = await loadDtlnAssets();
  log.info("ns", `dtln boot assets: processor=${processorText.length} chars wasm=${wasmBinary.byteLength}`);
  const context = await bootPipelineContext(DTLN_PIPELINE_SAMPLE_RATE);
  const workletUrl = URL.createObjectURL(new Blob([processorText], { type: "text/javascript" }));
  try {
    // Per-context module map (see createSpeexPipeline): addModule on the
    // pipeline's own context, every time.
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const node = new AudioWorkletNode(context, DTLN_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      threads: false, // no pthreads inside an AudioWorklet
      numThreads: 1,
      bypassUntilReady: false, // silence until ready — the handshake gates publishing anyway
      liteRtVariant: "relaxed", // this Electron Chromium always has relaxed SIMD
      liteRtWasmBinary: wasmBinary,
    },
  });
  // Their processor speaks a real handshake (unlike DFN3's): ready/error over
  // the port. Booting compiles an 8.8 MB wasm + two models inside the worklet
  // — 15 s of headroom.
  const boot = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const timeout = window.setTimeout(() => resolve({ ok: false, detail: "worklet boot timeout (15 s)" }), 15_000);
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; message?: string } | undefined;
      if (data === undefined) {
        return;
      }
      if (data.type === "ready") {
        window.clearTimeout(timeout);
        resolve({ ok: true, detail: "litert models live" });
      } else if (data.type === "error") {
        window.clearTimeout(timeout);
        resolve({ ok: false, detail: data.message ?? "unknown worklet error" });
      }
    };
  });
  if (!boot.ok) {
    node.port.onmessage = null;
    node.disconnect();
    void context.close();
    throw new Error(`DTLN worklet failed to boot: ${boot.detail}`);
  }
  log.info("ns", `dtln worklet ready (${boot.detail})`);
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; message?: string } | undefined;
    if (data !== undefined && data.type === "error") {
      log.error("ns", `dtln worklet died mid-stream: ${data.message ?? "?"} (publishing continues as silence until rebuilt)`);
    }
  };
  return {
    engine: "dtln",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    dispose(): void {
      node.port.postMessage({ type: "dispose" }); // their protocol: dtln_stop + ring cleanup
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      void context.close();
    },
  };
}

/** The mic-enhancer guard, extracted for tests: a freshly booted pipeline
 *  survives only when something still wants it. A call that is PREPARING its
 *  mic counts as wanting it — captureCallMic/wrapCallMic run BEFORE the
 *  PeerCallSession exists (both the outgoing ring and the accept), so the old
 *  "no live session" check killed EVERY engine boot on the 1-on-1 path and
 *  calls went out with the raw mic (live 2026-10-15: DFN3 silently missing in
 *  a call right after leaving a room). */
export function noisePipelineStillWanted(input: {
  rawTrackLive: boolean;
  voiceSessionAlive: boolean;
  callSessionAlive: boolean;
  callMicBootInFlight: boolean;
}): boolean {
  if (!input.rawTrackLive) {
    return false;
  }
  return input.voiceSessionAlive || input.callSessionAlive || input.callMicBootInFlight;
}
