/**
 * The native system-audio track (#485): Int16 PCM arrives over IPC from the
 * main-process WASAPI process-loopback capturer and is injected into the
 * WebAudio graph through a port-fed worklet ring — no input pins, the process()
 * quanta pull from the ring. The resulting MediaStreamDestination track is the
 * same shape the NS pipelines already publish (a WebAudio-synthesized track is
 * addTrack-able today). Ring sizing: ~250 ms of headroom — the IPC cadence is
 * 10 ms but a busy main can hiccup.
 */

import { log } from "../logging";

const INJECTOR_WORKLET_SOURCE = `
class PcmInjector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringLeft = new Float32Array(48000);  // 1 s per channel
    this.ringRight = new Float32Array(48000);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.pending = 0;
    this.underruns = 0;
    this.dropped = 0;
    this.rmsLeft = 0;
    this.rmsRight = 0;
    this.rmsCount = 0;
    this.statsTimer = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === "frame") {
        const samples = message.samples; // interleaved stereo Float32
        const frames = samples.length >> 1;
        const capacity = this.ringLeft.length - this.pending;
        if (frames > capacity) {
          // overflow: drop the OLDEST frames to stay live
          const drop = frames - capacity;
          this.readIndex = (this.readIndex + drop) % this.ringLeft.length;
          this.pending -= drop;
          this.dropped += drop;
        }
        for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
          this.ringLeft[this.writeIndex] = samples[frameIndex * 2];
          this.ringRight[this.writeIndex] = samples[frameIndex * 2 + 1];
          this.writeIndex = (this.writeIndex + 1) % this.ringLeft.length;
        }
        this.pending += frames;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const blockLength = output[0] ? output[0].length : 0;
    if (blockLength === 0) {
      return true;
    }
    const outLeft = output[0];
    const outRight = output.length > 1 ? output[1] : output[0];
    if (this.pending < blockLength) {
      this.underruns += 1;
      outLeft.fill(0);
      outRight.fill(0);
    } else {
      for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
        const left = this.ringLeft[this.readIndex];
        const right = this.ringRight[this.readIndex];
        outLeft[sampleIndex] = left;
        outRight[sampleIndex] = right;
        this.rmsLeft += left * left;
        this.rmsRight += right * right;
        this.rmsCount += 1;
        this.readIndex = (this.readIndex + 1) % this.ringLeft.length;
      }
      this.pending -= blockLength;
    }
    this.statsTimer += blockLength;
    if (this.statsTimer >= 48000) {
      this.port.postMessage({
        type: "stats",
        underruns: this.underruns,
        dropped: this.dropped,
        rmsLeft: this.rmsCount > 0 ? Math.sqrt(this.rmsLeft / this.rmsCount) : 0,
        rmsRight: this.rmsCount > 0 ? Math.sqrt(this.rmsRight / this.rmsCount) : 0,
      });
      this.statsTimer = 0;
      this.rmsLeft = 0;
      this.rmsRight = 0;
      this.rmsCount = 0;
    }
    return true;
  }
}

registerProcessor("space-pcm-injector", PcmInjector);
`;

export interface SystemAudioSourceStats {
  underruns: number;
  dropped: number;
  rmsLeft: number;
  rmsRight: number;
}

/** The sink the MONITOR ear follows — NOT a TS-lib method (feature-detect via
 *  the structural type, the NotificationHub.setOutputDevice precedent). */
type SinkCapableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

function applyContextSink(context: AudioContext, sinkId: string | null): void {
  const capable = context as SinkCapableAudioContext;
  if (sinkId !== null && typeof capable.setSinkId === "function") {
    capable.setSinkId(sinkId).catch((error: unknown) => {
      // a dead id falls back to the default device — on disk, not just silently
      log.warn("audio", `system-audio monitor sink "${sinkId}" failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

export interface SystemAudioSourceOptions {
  /** The monitor output follows the CONFIGURED speaker — without this the
   *  monitor ear goes to the system default device, which is often the very
   *  device the captured content plays on (a same-device tap sounds like an
   *  echo). The published track is a MediaStreamDestination and ignores it. */
  monitorSinkId?: string | null;
}

export interface SystemAudioSource {
  /** The synthesized stereo 48k track (publishable via addTrack). */
  readonly track: MediaStreamTrack;
  /** Feed one interleaved-stereo Int16 chunk from the IPC bridge. */
  feed(pcm: Int16Array): void;
  /** Local ear verification — the loopback is a TAP, so the double is safe. */
  setMonitor(enabled: boolean): void;
  /** Re-route the monitor ear (settings Apply / device change). */
  setMonitorSink(sinkId: string | null): void;
  /** Latest per-second worklet stats (null before the first window). */
  latestStats(): SystemAudioSourceStats | null;
  dispose(): void;
}

export async function createSystemAudioSource(options?: SystemAudioSourceOptions): Promise<SystemAudioSource> {
  const context = new AudioContext({ sampleRate: 48_000 });
  applyContextSink(context, options?.monitorSinkId ?? null);
  if (context.state !== "running") {
    await context.resume();
  }
  const blobUrl = URL.createObjectURL(new Blob([INJECTOR_WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    // Per-context registration, no caches (the #476 lesson).
    await context.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const node = new AudioWorkletNode(context, "space-pcm-injector", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const sink = context.createMediaStreamDestination();
  node.connect(sink);
  const track = sink.stream.getAudioTracks()[0];
  if (track === undefined) {
    throw new Error("system-audio sink produced no track");
  }

  const scratch = new Float32Array(24000); // grows to the largest chunk
  let stats: SystemAudioSourceStats | null = null;
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as SystemAudioSourceStats & { type?: string } | null;
    if (data?.type === "stats") {
      stats = { underruns: data.underruns, dropped: data.dropped, rmsLeft: data.rmsLeft, rmsRight: data.rmsRight };
    }
  };

  let monitorGain: GainNode | null = null;
  return {
    track,
    feed(pcm) {
      if (pcm.length > scratch.length) {
        return; // a >250 ms chunk would overflow anyway — the ring drops it safely
      }
      for (let index = 0; index < pcm.length; index += 1) {
        scratch[index] = pcm[index]! / 32768;
      }
      node.port.postMessage({ type: "frame", samples: scratch.slice(0, pcm.length) });
    },
    setMonitor(enabled) {
      if (enabled && monitorGain === null) {
        monitorGain = context.createGain();
        monitorGain.gain.value = 1;
        node.connect(monitorGain).connect(context.destination);
      } else if (!enabled && monitorGain !== null) {
        try {
          monitorGain.disconnect();
          node.disconnect(monitorGain);
        } catch {
          // already torn down
        }
        monitorGain = null;
      }
    },
    setMonitorSink(sinkId) {
      applyContextSink(context, sinkId);
    },
    latestStats: () => stats,
    dispose() {
      try {
        node.disconnect();
        sink.disconnect();
      } finally {
        void context.close().catch(() => undefined);
      }
    },
  };
}
