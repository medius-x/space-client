import { LEVEL_POLL_MS } from "./config";
import { log } from "./logging";
import { floatRms, isSpeaking, rmsToDbfs, speakingLevel } from "./core/audio-math";

/**
 * Remote-audio plumbing for the spike. Two lessons baked in from the live smokes:
 *
 * 1. PLAYOUT goes through a plain <audio> element DIRECTLY (element.volume as the
 *    gain). Remote WebRTC tracks were silent through BOTH createMediaStreamSource
 *    and a captured element (createMediaElementSource) — the bare element is the
 *    one path Chromium reliably plays. Trade-off: element.volume caps at 1.0, so
 *    the spike's >100% boost range is clamped.
 * 2. ANALYSIS (meters, speaking, stereo probe) rides a SEPARATE
 *    createMediaStreamSource feeding analysers only — never connected to
 *    destination. If Chromium feeds it, we get L/R meters; if not, playout still
 *    works and the meters simply read −∞ (we will see which in the diagnostics).
 *
 * Chains are keyed by FEED ID: two feeds sharing a display name (a stale
 * not-yet-timed-out publisher + the fresh one) must not clobber each other.
 */

export interface StereoReading {
  leftDbfs: number;
  rightDbfs: number;
  deltaDb: number;
  channelCount: number;
}

interface VoiceChain {
  username: string;
  element: HTMLAudioElement;
  analyser: AnalyserNode;
  analysisSource: MediaStreamAudioSourceNode;
  buffer: Float32Array<ArrayBuffer>;
  level: number;
}

interface ShareChain {
  username: string;
  element: HTMLAudioElement;
  analysisSource: MediaStreamAudioSourceNode;
  analyserLeft: AnalyserNode;
  analyserRight: AnalyserNode;
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
}

function playbackElement(track: MediaStreamTrack, initialVolume: number): HTMLAudioElement {
  const element = new Audio();
  element.autoplay = true;
  element.volume = Math.min(1, Math.max(0, initialVolume));
  element.srcObject = new MediaStream([track]);
  void element.play().catch(() => undefined);
  return element;
}

export class RoomAudio {
  private context: AudioContext | null = null;
  private readonly voiceChains = new Map<number, VoiceChain>();
  private readonly shareChains = new Map<number, ShareChain>();
  private speakingHandler: ((username: string, speaking: boolean) => void) | null = null;
  private readonly speakingNow = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private testTone: { left: OscillatorNode; right: OscillatorNode; merger: ChannelMergerNode } | null = null;
  private testToneChannel: "left" | "right" | null = null;
  private ownMic: {
    username: string;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    buffer: Float32Array<ArrayBuffer>;
    level: number;
  } | null = null;

  private ensureContext(): AudioContext {
    if (this.context === null) {
      this.context = new AudioContext();
      log.info("audio", `AudioContext created (${this.context.sampleRate} Hz, state=${this.context.state})`);
    }
    return this.context;
  }

  /** Call from the login click — browsers require a gesture to start audio. */
  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state !== "running") {
      await context.resume();
    }
    if (context.state !== "running") {
      log.error("audio", `AudioContext stuck in ${context.state} — analysis will read silence`);
      return;
    }
    log.info("audio", "AudioContext running");
  }

  getState(): AudioContextState | "none" {
    return this.context?.state ?? "none";
  }

  attachVoiceTrack(feedId: number, username: string, track: MediaStreamTrack, volume: number): void {
    this.detachFeed(feedId);
    const context = this.ensureContext();
    const element = playbackElement(track, volume);
    const analysisSource = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analysisSource.connect(analyser); // analysis only — NEVER to destination
    this.voiceChains.set(feedId, {
      username,
      element,
      analyser,
      analysisSource,
      buffer: new Float32Array(analyser.fftSize),
      level: 0,
    });
    log.info("audio", `voice chain attached: feed ${feedId} "${username}" (element playout @ ${element.volume.toFixed(2)})`);
  }

  attachShareTrack(feedId: number, username: string, track: MediaStreamTrack, volume: number): void {
    this.detachFeed(feedId);
    const context = this.ensureContext();
    const element = playbackElement(track, volume);
    const analysisSource = context.createMediaStreamSource(new MediaStream([track]));
    const splitter = context.createChannelSplitter(2);
    const analyserLeft = context.createAnalyser();
    const analyserRight = context.createAnalyser();
    analyserLeft.fftSize = 1024;
    analyserRight.fftSize = 1024;
    analysisSource.connect(splitter); // analysis tap tree — no destination anywhere
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);
    this.shareChains.set(feedId, {
      username,
      element,
      analysisSource,
      analyserLeft,
      analyserRight,
      left: new Float32Array(analyserLeft.fftSize),
      right: new Float32Array(analyserRight.fftSize),
    });
    log.info("audio", `share chain attached: feed ${feedId} "${username}" (element playout, track channels=${track.getSettings().channelCount ?? "?"})`);
  }

  detachFeed(feedId: number): void {
    const voice = this.voiceChains.get(feedId);
    if (voice) {
      this.teardownElement(voice.element);
      try {
        voice.analysisSource.disconnect();
        voice.analyser.disconnect();
      } catch {
        // already torn down
      }
      this.voiceChains.delete(feedId);
      this.emitSpeaking(voice.username, false);
    }
    const share = this.shareChains.get(feedId);
    if (share) {
      this.teardownElement(share.element);
      try {
        share.analysisSource.disconnect();
        share.analyserLeft.disconnect();
        share.analyserRight.disconnect();
      } catch {
        // already torn down
      }
      this.shareChains.delete(feedId);
    }
  }

  detachAll(): void {
    for (const feedId of [...this.voiceChains.keys(), ...this.shareChains.keys()]) {
      this.detachFeed(feedId);
    }
  }

  private teardownElement(element: HTMLAudioElement): void {
    try {
      element.pause();
      element.srcObject = null;
    } catch {
      // already torn down
    }
  }

  /** Applies to every feed chain carrying this username (stale duplicates included). */
  setVoiceVolume(username: string, gain: number): void {
    for (const chain of this.voiceChains.values()) {
      if (chain.username === username) {
        chain.element.volume = Math.min(1, Math.max(0, gain));
      }
    }
  }

  setShareVolume(username: string, gain: number): void {
    for (const chain of this.shareChains.values()) {
      if (chain.username === username) {
        chain.element.volume = Math.min(1, Math.max(0, gain));
      }
    }
  }

  setSpeakingHandler(handler: (username: string, speaking: boolean) => void): void {
    this.speakingHandler = handler;
  }

  /** Own speaking ring: local mic analysis only, never any playout (that would echo). */
  attachOwnMic(username: string, track: MediaStreamTrack): void {
    this.detachOwnMic();
    const context = this.ensureContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.ownMic = { username, source, analyser, buffer: new Float32Array(analyser.fftSize), level: 0 };
  }

  detachOwnMic(): void {
    if (!this.ownMic) {
      return;
    }
    try {
      this.ownMic.source.disconnect();
      this.ownMic.analyser.disconnect();
    } catch {
      // already torn down
    }
    this.ownMic = null;
  }

  startLevelPolling(intervalMs = LEVEL_POLL_MS): void {
    this.stopLevelPolling();
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  stopLevelPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    const own = this.ownMic;
    if (own) {
      own.analyser.getFloatTimeDomainData(own.buffer);
      own.level = speakingLevel(floatRms(own.buffer), own.level);
      this.emitSpeaking(own.username, isSpeaking(own.level));
    }
    for (const chain of this.voiceChains.values()) {
      chain.analyser.getFloatTimeDomainData(chain.buffer);
      chain.level = speakingLevel(floatRms(chain.buffer), chain.level);
      this.emitSpeaking(chain.username, isSpeaking(chain.level));
    }
  }

  private emitSpeaking(username: string, speaking: boolean): void {
    const was = this.speakingNow.has(username);
    if (speaking === was) {
      return;
    }
    if (speaking) {
      this.speakingNow.add(username);
    } else {
      this.speakingNow.delete(username);
    }
    this.speakingHandler?.(username, speaking);
  }

  /** dBFS of the latest voice frame of any chain with this username (meter readout). */
  getVoiceLevelDbfs(username: string): number | null {
    for (const chain of this.voiceChains.values()) {
      if (chain.username === username) {
        return rmsToDbfs(floatRms(chain.buffer));
      }
    }
    return null;
  }

  getShareLevelDbfs(username: string): number | null {
    for (const chain of this.shareChains.values()) {
      if (chain.username === username) {
        return rmsToDbfs(Math.max(floatRms(chain.left), floatRms(chain.right)));
      }
    }
    return null;
  }

  /** The acoustic stereo reading (analysis taps; refreshes buffers on call). */
  stereoProbe(username: string): StereoReading | null {
    for (const chain of this.shareChains.values()) {
      if (chain.username !== username) {
        continue;
      }
      chain.analyserLeft.getFloatTimeDomainData(chain.left);
      chain.analyserRight.getFloatTimeDomainData(chain.right);
      const leftDbfs = rmsToDbfs(floatRms(chain.left));
      const rightDbfs = rmsToDbfs(floatRms(chain.right));
      return {
        leftDbfs,
        rightDbfs,
        deltaDb: Math.abs(leftDbfs - rightDbfs),
        channelCount: chain.analysisSource.channelCount,
      };
    }
    return null;
  }

  /** The publisher end of the stereo oracle: 440 Hz HARD-PANNED to ONE channel, the
   *  other silent. CRITICAL calibration (live smoke 2026-09-03): equal-amplitude tones
   *  in both channels read Δ≈0 dB even through PERFECT stereo — the |L−R| oracle needs
   *  a hard-panned source. Sequential L-then-R testing also catches channel swaps and
   *  one-sided channel failures that a single L tone cannot. */
  startStereoTestTone(channel: "left" | "right"): void {
    this.stopStereoTestTone();
    const context = this.ensureContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    const merger = context.createChannelMerger(2);
    const attenuation = context.createGain();
    attenuation.gain.value = 0.15;
    oscillator.connect(merger, 0, channel === "left" ? 0 : 1); // the other merger input stays unconnected = digital silence
    merger.connect(attenuation);
    attenuation.connect(context.destination);
    oscillator.start();
    this.testTone = { left: oscillator, right: oscillator, merger };
    this.testToneChannel = channel;
    log.info("audio", `stereo test tone ON (440 Hz ${channel.toUpperCase()} ONLY @ 15%)`);
  }

  stopStereoTestTone(): void {
    if (!this.testTone) {
      return;
    }
    try {
      this.testTone.left.stop();
      this.testTone.merger.disconnect();
    } catch {
      // already stopped
    }
    this.testTone = null;
    this.testToneChannel = null;
    log.info("audio", "stereo test tone OFF");
  }

  isTestTonePlaying(): boolean {
    return this.testTone !== null;
  }

  getTestToneChannel(): "left" | "right" | null {
    return this.testToneChannel;
  }

  dispose(): void {
    this.stopLevelPolling();
    this.stopStereoTestTone();
    this.detachOwnMic();
    this.detachAll();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
