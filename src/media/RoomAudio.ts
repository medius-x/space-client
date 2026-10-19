import { LEVEL_POLL_MS } from "../config";
import { log } from "../logging";
import { floatRms, isSpeaking, rmsToDbfs, speakingLevel } from "../core/audio-math";

/** DOMExceptions often carry an EMPTY message — the name is the signal (device-lesson). */
function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    return `${error.name}${error.message.length > 0 ? `: ${error.message}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remote-audio plumbing. Two lessons baked in from the live smokes:
 *
 * 1. PLAYOUT (2026-10-19 revision) goes through the WebAudio graph: the SAME
 *    createMediaStreamSource the analysers ride also feeds a per-chain GAIN
 *    (0..2) into the context destination, and the <audio> element is muted —
 *    element.volume caps at 1.0 (a platform limit), which had silently killed
 *    the whole >100% half of the per-user volume sliders (live report
 *    2026-10-19: "only the left half of the slider works"). The analysis taps
 *    proved the source feeds reliably long ago (speaking meters). If the graph
 *    cannot be built, the chain falls back to the legacy element path with its
 *    100% ceiling — audio never dies because of the feature.
 * 2. ANALYSIS (meters, speaking, stereo probe) rides SEPARATE connections from
 *    that same source into analysers only. The share chain's SPLITTER taps are
 *    analysis-only: a splitter output carries ONE channel, so the playout and
 *    the #483 reference gains are fed from the source DIRECTLY (stereo kept).
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
  track: MediaStreamTrack;
  element: HTMLAudioElement;
  analyser: AnalyserNode;
  analysisSource: MediaStreamAudioSourceNode;
  buffer: Float32Array<ArrayBuffer>;
  level: number;
  /** The user-set volume; the playout gain (or the fallback element) is this
   *  OR 0 while deafened. */
  volume: number;
  /** The PLAYOUT gain (0..2) feeding the context destination — null when the
   *  graph could not be built (legacy element path then applies the volume,
   *  capped at 100%). */
  playoutGain: GainNode | null;
  /** Mirrors the effective playout level into the share-subtraction reference
   *  (#483): the analysis source carries the RAW track, so the reference chain
   *  must apply the same gain the playout applies. */
  referenceGain: GainNode;
}

interface ShareChain {
  username: string;
  track: MediaStreamTrack;
  element: HTMLAudioElement;
  analysisSource: MediaStreamAudioSourceNode;
  analyserLeft: AnalyserNode;
  analyserRight: AnalyserNode;
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
  volume: number;
  /** Same as VoiceChain.playoutGain. */
  playoutGain: GainNode | null;
  /** Same mirror as VoiceChain.referenceGain (#483). */
  referenceGain: GainNode;
}

function playbackElement(track: MediaStreamTrack, chainLabel: string): HTMLAudioElement {
  const element = new Audio();
  element.autoplay = true;
  // The element is the CARRIER of the track into Chromium's decode pipeline —
  // its own audibility is zeroed by the caller once the graph playout is up
  // (element.volume caps at 1.0; the graph gain is the real 0..2 volume).
  element.volume = 0;
  element.srcObject = new MediaStream([track]);
  // A failed play() means the pipeline never spins up while every log line
  // looks healthy — these failures must be on disk (logging round, 2026-10-06).
  void element.play().catch((error: unknown) => {
    log.warn("audio", `playback (${chainLabel}) play() failed: ${describeError(error)}`);
  });
  return element;
}

export class RoomAudio {
  private context: AudioContext | null = null;
  private readonly voiceChains = new Map<number, VoiceChain>();
  private readonly shareChains = new Map<number, ShareChain>();
  /** The share-subtraction reference tap (#483): every chain's analysis source
   *  feeds a per-chain volume-mirroring gain into this bus; the bus is exposed
   *  as a NODE for same-context consumers (the subtractor — a track crossing
   *  between contexts drifts and turns the subtraction metallic) and lazily as
   *  a stream for anything else. */
  private referenceBus: GainNode | null = null;
  private referenceDest: MediaStreamAudioDestinationNode | null = null;
  /** The picked output device (client settings, oak Audio); null = default.
   *  Applied to every NEW playback element and re-applied live on change. */
  private outputDeviceId: string | null = null;
  private speakingHandler: ((username: string, speaking: boolean) => void) | null = null;
  private readonly speakingNow = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private testTone: { left: OscillatorNode; right: OscillatorNode; merger: ChannelMergerNode } | null = null;
  private testToneChannel: "left" | "right" | null = null;
  /** Deafen compliance — silences every playback element, volumes restored on undeafen. */
  private deafened = false;
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
      this.applyContextSink(this.context);
      log.info("audio", `AudioContext created (${this.context.sampleRate} Hz, state=${this.context.state})`);
    }
    return this.context;
  }

  /** AudioContext.setSinkId is structural-typed (absent from the TS libs) —
   *  the same feature-detect NotificationHub uses. The whole graph playout
   *  follows the context sink. */
  private applyContextSink(context: AudioContext): void {
    const sink = (context as unknown as { setSinkId?: (deviceId: string) => Promise<void> }).setSinkId;
    if (typeof sink !== "function") {
      log.warn("audio", "AudioContext.setSinkId unavailable — graph playout stays on the default device");
      return;
    }
    void sink.call(context, this.outputDeviceId ?? "").catch((error: unknown) => {
      log.warn("audio", `context setSinkId("${this.outputDeviceId ?? "default"}") failed: ${describeError(error)}`);
    });
  }

  private ensureReferenceBus(): GainNode {
    if (this.referenceBus === null) {
      this.referenceBus = this.ensureContext().createGain();
    }
    return this.referenceBus;
  }

  private ensureReferenceDest(): MediaStreamAudioDestinationNode {
    if (this.referenceDest === null) {
      this.referenceDest = this.ensureContext().createMediaStreamDestination();
      this.ensureReferenceBus().connect(this.referenceDest);
    }
    return this.referenceDest;
  }

  /** The context every same-context consumer (the share subtractor) must use —
   *  a cross-CONTEXT reference track drifts a few samples (Chromium's clock
   *  reconciliation) and the subtraction turns metallic (live smoke 2026-09-18). */
  getAudioContext(): AudioContext {
    return this.ensureContext();
  }

  /** The reference tap as a NODE — same-context consumers connect this directly
   *  into their graph (no track crossing, no delivery drift). */
  getReferenceBus(): GainNode {
    return this.ensureReferenceBus();
  }

  /** The single effective-level expression shared by the playout gain and the
   *  reference mirror (deafen zeroes both). The ceiling is 2.0 — the >100%
   *  half of the volume sliders, unrepresentable through element.volume. */
  private effectiveVolume(volume: number): number {
    return this.deafened ? 0 : Math.min(2, Math.max(0, volume));
  }

  /** The reconstructed playout of every attached chain (#483): the share
   *  subtractor consumes this as its reference (null never happens — the call
   *  creates the destination, and an empty one is a valid silent reference). */
  getReferenceStream(): MediaStream {
    return this.ensureReferenceDest().stream;
  }

  /** Call from the login click — browsers require a gesture to start audio. */
  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state !== "running") {
      await context.resume();
    }
    if (context.state !== "running") {
      log.error("audio", `AudioContext stuck in ${context.state} — graph playout and analysis are silent`);
      return;
    }
    log.info("audio", "AudioContext running");
  }

  getState(): AudioContextState | "none" {
    return this.context?.state ?? "none";
  }

  /** Live output switch (the speaker is an immediate property, oak parity).
   *  The context sink moves the WHOLE graph playout; the per-element sinks only
   *  matter for fallback chains still playing through their element. */
  setOutputDevice(deviceId: string | null): void {
    this.outputDeviceId = deviceId;
    if (this.context !== null) {
      this.applyContextSink(this.context);
    }
    for (const chain of [...this.voiceChains.values(), ...this.shareChains.values()]) {
      if (chain.playoutGain === null && typeof chain.element.setSinkId === "function") {
        void chain.element.setSinkId(deviceId ?? "").catch((error: unknown) => {
          log.warn("audio", `output switch to "${deviceId ?? "default"}" failed: ${describeError(error)}`);
        });
      }
    }
  }

  attachVoiceTrack(feedId: number, username: string, track: MediaStreamTrack, volume: number): void {
    // Idempotent re-delivery: a recycled m-line hands us the SAME track object
    // again — rebuilding would churn the element (a fresh <audio> spins up its
    // playout from scratch: the seconds-long "voice missing" after a watch).
    const existingVoice = this.voiceChains.get(feedId);
    if (existingVoice !== undefined && existingVoice.track === track) {
      return;
    }
    this.detachVoiceFeed(feedId);
    const context = this.ensureContext();
    if (context.state !== "running") {
      void this.resume(); // the graph playout lives and dies by the context state
    }
    const element = playbackElement(track, `voice ${username}`);
    const analysisSource = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analysisSource.connect(analyser); // analysis only — NEVER to destination
    const referenceGain = context.createGain();
    referenceGain.gain.value = this.effectiveVolume(volume);
    analysisSource.connect(referenceGain); // the subtraction reference tap (#483)
    referenceGain.connect(this.ensureReferenceBus());
    const playoutGain = this.buildPlayoutGain(analysisSource, volume, `voice ${username}`);
    this.applyCarrierVolume(element, playoutGain, volume);
    this.voiceChains.set(feedId, {
      username,
      track,
      element,
      analyser,
      analysisSource,
      buffer: new Float32Array(analyser.fftSize),
      level: 0,
      volume,
      playoutGain,
      referenceGain,
    });
    log.info("audio", `voice chain attached: feed ${feedId} "${username}" (${playoutGain !== null ? `graph playout @ ${this.effectiveVolume(volume).toFixed(2)}` : "element fallback playout"})`);
  }

  attachShareTrack(feedId: number, username: string, track: MediaStreamTrack, volume: number): void {
    // Same idempotence as attachVoiceTrack: the watch-flip re-attach and the
    // recycled-track delivery both re-hand the live track over.
    const existingShare = this.shareChains.get(feedId);
    if (existingShare !== undefined && existingShare.track === track) {
      return;
    }
    this.detachShareFeed(feedId);
    const context = this.ensureContext();
    if (context.state !== "running") {
      void this.resume();
    }
    const element = playbackElement(track, `share ${username}`);
    const analysisSource = context.createMediaStreamSource(new MediaStream([track]));
    const splitter = context.createChannelSplitter(2);
    const analyserLeft = context.createAnalyser();
    const analyserRight = context.createAnalyser();
    analyserLeft.fftSize = 1024;
    analyserRight.fftSize = 1024;
    analysisSource.connect(splitter); // the ANALYSIS tap tree (one channel per output)
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);
    const referenceGain = context.createGain();
    referenceGain.gain.value = this.effectiveVolume(volume);
    analysisSource.connect(referenceGain); // the subtraction reference tap (#483)
    referenceGain.connect(this.ensureReferenceBus());
    // The playout/ref gains are fed from the SOURCE directly (a splitter output
    // carries one channel — stereo would collapse, the M0 lesson).
    const playoutGain = this.buildPlayoutGain(analysisSource, volume, `share ${username}`);
    this.applyCarrierVolume(element, playoutGain, volume);
    this.shareChains.set(feedId, {
      username,
      track,
      element,
      analysisSource,
      analyserLeft,
      analyserRight,
      left: new Float32Array(analyserLeft.fftSize),
      right: new Float32Array(analyserRight.fftSize),
      volume,
      playoutGain,
      referenceGain,
    });
    log.info("audio", `share chain attached: feed ${feedId} "${username}" (${playoutGain !== null ? "graph playout" : "element fallback playout"}, track channels=${track.getSettings().channelCount ?? "?"})`);
  }

  /** The graph playout gain (0..2) into the context destination. Null = the
   *  graph could not be built (a hard failure, e.g. a closed context): the
   *  caller keeps the LEGACY element playout, capped at 100% — audio survives
   *  the feature failing. */
  private buildPlayoutGain(source: MediaStreamAudioSourceNode, volume: number, chainLabel: string): GainNode | null {
    try {
      const gain = this.ensureContext().createGain();
      gain.gain.value = this.effectiveVolume(volume);
      source.connect(gain);
      gain.connect(this.ensureContext().destination);
      return gain;
    } catch (error: unknown) {
      log.warn("audio", `playout graph build failed (${chainLabel}): ${describeError(error)} — falling back to the element path (boost capped at 100%)`);
      return null;
    }
  }

  /** The carrier element is SILENT while the graph owns the playout; on the
   *  fallback path it carries the volume itself (platform-capped at 1.0). */
  private applyCarrierVolume(element: HTMLAudioElement, playoutGain: GainNode | null, volume: number): void {
    element.volume = playoutGain !== null ? 0 : Math.min(1, this.effectiveVolume(volume));
  }

  detachFeed(feedId: number): void {
    this.detachVoiceFeed(feedId);
    this.detachShareFeed(feedId);
  }

  /** Tear down ONLY the voice chain — a share starting/stopping must never
   *  kill the peer's voice playout (the pre-split attachShareTrack did exactly
   *  that: every watch left the sharer mute until a rejoin). */
  private detachVoiceFeed(feedId: number): void {
    const voice = this.voiceChains.get(feedId);
    if (voice) {
      this.teardownElement(voice.element);
      try {
        voice.analysisSource.disconnect();
        voice.analyser.disconnect();
        voice.referenceGain.disconnect();
        voice.playoutGain?.disconnect();
      } catch {
        // already torn down
      }
      this.voiceChains.delete(feedId);
      this.emitSpeaking(voice.username, false);
    }
  }

  /** Tear down ONLY the share chain — public: the "share ended" path. */
  detachShareFeed(feedId: number): void {
    const share = this.shareChains.get(feedId);
    if (share) {
      this.teardownElement(share.element);
      try {
        share.analysisSource.disconnect();
        share.analyserLeft.disconnect();
        share.analyserRight.disconnect();
        share.referenceGain.disconnect();
        share.playoutGain?.disconnect();
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
        chain.volume = gain;
        this.applyChainVolume(chain);
      }
    }
  }

  setShareVolume(username: string, gain: number): void {
    for (const chain of this.shareChains.values()) {
      if (chain.username === username) {
        chain.volume = gain;
        this.applyChainVolume(chain);
      }
    }
  }

  /** THE volume point: the graph playout gain (or the fallback element) AND
   *  the #483 reference mirror move together. */
  private applyChainVolume(chain: VoiceChain | ShareChain): void {
    const effective = this.effectiveVolume(chain.volume);
    if (chain.playoutGain !== null) {
      chain.playoutGain.gain.value = effective;
      chain.element.volume = 0;
    } else {
      chain.element.volume = Math.min(1, effective);
    }
    chain.referenceGain.gain.value = effective;
  }

  /** Deafen compliance: everything goes silent, per-chain volumes come back on undeafen. */
  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) {
      return;
    }
    this.deafened = deafened;
    for (const chain of this.voiceChains.values()) {
      this.applyChainVolume(chain);
    }
    for (const chain of this.shareChains.values()) {
      this.applyChainVolume(chain);
    }
    log.info("audio", `deafen ${deafened ? "ON — playout silenced" : "OFF — volumes restored"}`);
  }

  isDeafened(): boolean {
    return this.deafened;
  }

  setSpeakingHandler(handler: (username: string, speaking: boolean) => void): void {
    this.speakingHandler = handler;
  }

  /**
   * The live speaking set as a fresh snapshot (oak's pollSpeakingLevels model):
   * the room view polls this every 150 ms and repaints the whole set, so a
   * missed "stopped speaking" edge self-heals on the next tick instead of
   * leaving a green frame lit forever (live report).
   */
  speakingSnapshot(): Set<string> {
    return new Set(this.speakingNow);
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
    this.deafened = false; // deafen is room state — a fresh session starts hearing
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
