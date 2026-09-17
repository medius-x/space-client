// LAZY-CHUNKED: the "sync" glue inlines the whole wasm as base64 (~1.9 MB of
// string) — importing it statically would bloat the main bundle. The dynamic
// ?raw import keeps it a separate chunk that loads when an engine boots
// (typed by the "*?raw" module declaration in src/vite-raw.d.ts).

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
 * Both engines share this integration shape, so switching is uniform:
 *  - RNNoise  — @jitsi/rnnoise-wasm "sync" build (wasm inlined as base64,
 *    designed for AudioWorklets), our own processor with the framing pinned by
 *    domain/logic/rnnoise-framing tests;
 *  - DeepFilterNet3 — the deepfilternet3-noise-filter package, LAZY-imported so
 *    its heavy assets load only when the engine is selected. The package fetches
 *    its wasm + ONNX model from a CDN by default — unacceptable for a
 *    self-hosted/offline app — so both files are vendored into
 *    src/renderer/public/df3/ and cdnUrl points at the local copies.
 */
export type NoiseEngineKind = "off" | "rnnoise" | "deepfilternet3";

/** The audio rate every engine path is built around (RNNoise's 480-sample frame
 *  is 10 ms at 48 kHz; the capture constraints request the same rate). */
export const NOISE_PIPELINE_SAMPLE_RATE = 48000;

export interface NoisePipeline {
  readonly engine: NoiseEngineKind;
  /** The processed track to publish; the RAW track stays owned by the caller. */
  readonly track: MediaStreamTrack;
  /** Last VAD probability reported by the engine (diagnostics only). */
  readonly vad: number | null;
  /** Tear the WebAudio detour down; does NOT stop the raw track. */
  dispose(): void;
}

export async function createNoisePipeline(engine: NoiseEngineKind, rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  if (engine === "rnnoise") {
    return createRnnoisePipeline(rawTrack);
  }
  return createDeepFilterPipeline(rawTrack);
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
  const context = new AudioContext({ sampleRate: NOISE_PIPELINE_SAMPLE_RATE, latencyHint: "interactive" });
  void context.resume();
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

interface DeepFilter3Module {
  DeepFilterNet3Core: new (config: {
    sampleRate?: number;
    noiseReductionLevel?: number;
    assetConfig?: { cdnUrl?: string };
  }) => {
    initialize(): Promise<void>;
    createAudioWorkletNode(context: AudioContext): Promise<AudioWorkletNode>;
    setNoiseSuppressionEnabled(enabled: boolean): void;
    destroy(): void;
  };
}

async function createDeepFilterPipeline(rawTrack: MediaStreamTrack): Promise<NoisePipeline> {
  const { DeepFilterNet3Core } = (await import("deepfilternet3-noise-filter")) as unknown as DeepFilter3Module;
  // Vendored assets (src/renderer/public/df3) instead of the package's CDN —
  // the app must work offline and never phone home for models.
  const core = new DeepFilterNet3Core({
    sampleRate: NOISE_PIPELINE_SAMPLE_RATE,
    noiseReductionLevel: 50,
    assetConfig: { cdnUrl: "df3" },
  });
  await core.initialize();
  const context = new AudioContext({ sampleRate: NOISE_PIPELINE_SAMPLE_RATE, latencyHint: "interactive" });
  void context.resume();
  const node = await core.createAudioWorkletNode(context);
  const source = context.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  return {
    engine: "deepfilternet3",
    track: destination.stream.getAudioTracks()[0] ?? rawTrack,
    vad: null,
    dispose(): void {
      source.disconnect();
      node.disconnect();
      core.destroy();
      void context.close();
    },
  };
}
