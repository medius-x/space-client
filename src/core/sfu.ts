import { log } from "../logging";
import type { FeedInfo, RemoteTrackKind, RoomInfo } from "../types";
import type { JanusClient, JanusJsep } from "./janus";
import { isBadPin, isRoomVanished, type VideoroomEvent } from "./janus-events";
import {
  classifyFeed,
  diffSubscriptions,
  SlotMidTranslator,
  streamKey,
  wantedStreams,
  type StreamRef,
} from "./classifier";
import { extractAudioFmtpLines, mungeStereoIntoAnswerIfOfferHasIt, mungeStereoIntoOffer } from "./sdp";

/**
 * Publisher + subscriber orchestration against the videoroom SFU — the distilled
 * semantics of the Java SfuService, minus its audio engine (Chromium owns that):
 *
 *  - EMPTY RTCConfiguration (host candidates; the Janus gateway is local).
 *  - VANILLA ICE: the initial offer/answer waits for icegatheringcomplete so the
 *    candidates are baked into the SDP; renegotiations on a connected PC send
 *    immediately (BUNDLE never re-fires gathering).
 *  - onnegotiationneeded is a HARD no-op on the publisher PC — Janus's recvonly
 *    answer mismatches our sendrecv offer and would loop renegotiations, growing a
 *    video m-line per round. Offers are explicit and serialized by a busy-guard.
 *  - The subscriber join is DEFERRED until at least one wanted stream exists (an
 *    empty streams array is rejected 429 and poisons the handle permanently).
 *  - Track routing goes through SlotMidTranslator (slot mid ≠ stream mid); video
 *    tracks fall back to the FIFO of pending video subscriptions when the slot is
 *    unknown (stale after slot reuse).
 */

export interface SfuCallbacks {
  /** Full participants snapshot (UI re-render trigger). */
  onParticipants(feeds: FeedInfo[]): void;
  onRemoteTrack(feedId: number, username: string, kind: RemoteTrackKind, track: MediaStreamTrack): void;
  onRemoteTrackEnded(feedId: number, username: string, kind: RemoteTrackKind): void;
  onState(state: "connecting" | "live" | "reconnecting" | "failed", detail?: string): void;
  /** Transport-level fatality; 426 (room vanished) is signalled via RoomVanishedError. */
  onError(error: Error): void;
  /** Why this member's mic might be legitimately silent (the voice-control marks:
   *  a muted publisher sends NO RTP, so the incoming track stays muted — that is
   *  not a fault). Returns null when the member carries no marks. Used to keep
   *  the still-muted watchdog from crying wolf on a muted publisher. */
  describeMuteState?(username: string): string | null;
}

export class RoomVanishedError extends Error {
  constructor() {
    super("janus room vanished (426)");
    this.name = "RoomVanishedError";
  }
}

export class BadPinError extends Error {
  constructor() {
    super("janus room rejected the pin (433)");
    this.name = "BadPinError";
  }
}

/** The subscriber transport died (ICE failure) — incoming media is gone for good.
 *  The runtime reacts by climbing the rejoin ladder (a manual re-click used to be
 *  the only cure — the failure was completely silent before this signal). */
export class SubscriberTransportError extends Error {
  constructor() {
    super("subscriber peer connection failed");
    this.name = "SubscriberTransportError";
  }
}

/** The publisher (outgoing) peer connection hit ICE failure — recoverable only
 *  by a full rejoin, like the subscriber twin. */
export class PublisherTransportError extends Error {
  constructor() {
    super("publisher peer connection failed");
    this.name = "PublisherTransportError";
  }
}

/** Seam for tests: media acquisition lives behind this, production binds navigator. */
export interface MediaSource {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface SfuSessionOptions {
  room: RoomInfo;
  username: string;
  janus: JanusClient;
  /** The publisher videoroom handle id from janus.open(). */
  publisherHandleId: number;
  mediaSource: MediaSource;
  peerConnectionImpl?: typeof RTCPeerConnection;
  callbacks: SfuCallbacks;
}

const ICE_GATHERING_TIMEOUT_MS = 2_000;

/** The videoroom's REMB ceiling for our publisher. Janus defaults a room to
 *  1 Mbps (oak-server's ensureRoom creates rooms without a `bitrate`), and
 *  the gateway tells the browser's encoder about it via REMB — every picker
 *  preset above 1 Mbps was silently crushed to it (the "viewer sees it
 *  choppy at max settings" live report: 16 Mbps picked, ~1 Mbps encoded).
 *  The join/configure `bitrate` overrides it per publisher; this constant
 *  stays ABOVE the picker's max preset so the sender-side maxBitrate (the
 *  user's actual choice) remains the only effective cap. */
const PUBLISHER_BITRATE_CEILING_BPS = 20_000_000;

/** Compact audio-fmtp summary for the log (the stereo evidence trail). */
function fmtpSummary(sdp: string): string {
  const lines = extractAudioFmtpLines(sdp);
  if (lines.length === 0) {
    return "(no audio m-lines)";
  }
  return lines.map((line) => `m${line.mindex}${line.mid ? `(${line.mid})` : ""}: ${line.fmtp ?? "no-fmtp"}`).join(" | ");
}

/** One raw snapshot for the share-video telemetry (the diag "share out/in"
 *  lines): the counters exactly as getStats reports them — RATES are the
 *  caller's delta job. Null fields = the stat was absent from the report. */
export interface VideoRtpCounters {
  timestamp: number;
  bytes: number;
  frames: number;
  /** The track entry's own rate: capture input fps (out) / decoded fps (in). */
  framesPerSecond: number | null;
  width: number | null;
  height: number | null;
  framesDropped: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Chrome links an rtp entry to its MediaStreamTrack through a two-hop:
 *  rtp.trackId → the track-stats entry → trackIdentifier === track.id.
 *  Returns BOTH entries when that track sends/receives video. */
function videoEntriesForTrack(report: RTCStatsReport, direction: "outbound-rtp" | "inbound-rtp", trackIdentifier: string): { rtp: Record<string, unknown>; track: Record<string, unknown> } | null {
  const trackStats = new Map<string, Record<string, unknown>>();
  report.forEach((stat) => {
    if (stat.type === "track" && stat.kind === "video") {
      const record = stat as unknown as Record<string, unknown>;
      if (typeof record.id === "string") {
        trackStats.set(record.id, record);
      }
    }
  });
  let pair: { rtp: Record<string, unknown>; track: Record<string, unknown> } | null = null;
  report.forEach((stat) => {
    if (pair !== null || stat.type !== direction || stat.kind !== "video") {
      return;
    }
    const rtp = stat as unknown as Record<string, unknown>;
    if (typeof rtp.trackId !== "string") {
      return;
    }
    const track = trackStats.get(rtp.trackId);
    if (track !== undefined && track.trackIdentifier === trackIdentifier) {
      pair = { rtp, track };
    }
  });
  return pair;
}

export class SfuSession {
  private readonly room: RoomInfo;
  private readonly username: string;
  private readonly janus: JanusClient;
  private readonly publisherHandleId: number;
  private readonly mediaSource: MediaSource;
  private readonly createPeerConnection: () => RTCPeerConnection;
  private readonly callbacks: SfuCallbacks;
  /** Mic post-processing (the noise-suppression pipeline, runtime-owned).
   *  start() runs the RAW track through it BEFORE the publisher sees a sample,
   *  so no unprocessed frames leak while the engine spins up. The enhancer owns
   *  its WebAudio detour; this class only carries the resulting track. */
  micEnhancer: ((track: MediaStreamTrack) => Promise<MediaStreamTrack>) | null = null;
  /** Picked microphone (client settings, oak Audio); null = system default. Next start(). */
  microphoneDeviceId: string | null = null;

  private publisherPc: RTCPeerConnection | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private micSender: RTCRtpSender | null = null;
  private screenVideoSender: RTCRtpSender | null = null;
  private shareAudioSender: RTCRtpSender | null = null;
  private shareAudioTrackId: string | null = null;
  private shareAudioTrack: MediaStreamTrack | null = null;
  private cameraVideoSender: RTCRtpSender | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  /** Compliance survives a rejoin: the desired mute state re-applies to the FRESH tracks. */
  private micMutedDesired = false;
  private shareAudioMutedDesired = false;
  private closed = false;
  private publisherIceReady = false;
  private publisherOfferBusy = false;
  private publisherOfferQueued = false;

  private subscriberHandleId: number | null = null;
  private subscriberPc: RTCPeerConnection | null = null;
  private subscriberJoined = false;
  private subscriberIceReady = false;
  private subscriberAnswerBusy = false;
  /** Single-slot stash: an offer arriving mid-answer is drained next, latest wins. */
  private pendingSubscriberOffer: JanusJsep | null = null;
  private readonly subscribedKeys = new Set<string>();
  private readonly feeds = new Map<number, FeedInfo>();
  private readonly translator = new SlotMidTranslator();
  /** FIFO of video stream-mids awaiting a track (slot mids go stale after reuse). */
  private readonly pendingVideoSubscriptions: { feedId: number; mid: string }[] = [];
  private readonly viewedFeedIds = new Set<number>();
  private lastSubscriberOfferSdp: string | null = null;

  constructor(options: SfuSessionOptions) {
    this.room = options.room;
    this.username = options.username;
    this.janus = options.janus;
    this.publisherHandleId = options.publisherHandleId;
    this.mediaSource = options.mediaSource;
    this.createPeerConnection = () => new (options.peerConnectionImpl ?? RTCPeerConnection)();
    this.callbacks = options.callbacks;
  }

  // ---------------------------------------------------------------------------
  // Publisher
  // ---------------------------------------------------------------------------

  /**
   * Mic up + join + publish. The mic rides m-line 0 (addTrack order fixes mindex —
   * share-audio classification on the subscriber side depends on it).
   */
  async start(): Promise<void> {
    this.callbacks.onState("connecting");
    let micStream: MediaStream;
    // AEC/AGC are ALWAYS ON (echo hurts the other listeners — no knob); the
    // built-in noiseSuppression is ALWAYS OFF — that job belongs to the
    // selectable engine, and two stacked suppressors mangle speech. No
    // sampleRate constraint — the pipeline's AudioContext resamples on its own.
    const micConstraints = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      ...(this.microphoneDeviceId !== null ? { deviceId: { exact: this.microphoneDeviceId } } : {}),
    };
    try {
      micStream = await this.mediaSource.getUserMedia({ audio: micConstraints });
    } catch (error: unknown) {
      // Chromium scopes media device ids PER ORIGIN: an id saved by another
      // window kind (dev server vs packaged file://) — or a yanked USB mic —
      // makes the exact constraint unsatisfiable. Fall back to the system
      // default instead of refusing the room.
      if (this.microphoneDeviceId !== null && error instanceof DOMException && error.name === "OverconstrainedError") {
        log.warn("sfu", "saved microphone unavailable in this window — using the system default");
        try {
          const { deviceId: _dropped, ...defaultConstraints } = micConstraints;
          micStream = await this.mediaSource.getUserMedia({ audio: defaultConstraints });
        } catch (fallbackError: unknown) {
          log.error("sfu", `microphone unavailable: ${fallbackError instanceof DOMException ? fallbackError.name : String(fallbackError)}`);
          this.callbacks.onState("failed", "microphone unavailable");
          throw fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        }
      } else {
        // The state line shows a generic verdict — the real cause (permission,
        // busy device) must land in the log. DOMExceptions often carry an
        // EMPTY message — the name is the readable half.
        const described = error instanceof DOMException
          ? `${error.name}`
          : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        log.error("sfu", `microphone unavailable: ${described}`);
        this.callbacks.onState("failed", "microphone unavailable");
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.closed) {
      for (const track of micStream.getTracks()) {
        track.stop();
      }
      return;
    }
    let micTrack = micStream.getAudioTracks()[0] ?? null;
    if (micTrack !== null && this.micEnhancer !== null) {
      try {
        micTrack = await this.micEnhancer(micTrack);
      } catch (error) {
        // The engine failed to boot — publish the raw track rather than no audio.
        log.warn("sfu", `noise suppression unavailable, publishing raw mic: ${String(error)}`);
      }
    }
    this.micTrack = micTrack;
    if (this.micTrack && this.micMutedDesired) {
      this.micTrack.enabled = false; // re-entered a room while server-muted — comply immediately
    }

    const publisher = this.createPeerConnection();
    this.publisherPc = publisher;
    // CRITICAL no-op: renegotiations are explicit (start/startShare/stopShare) — see class doc.
    publisher.onnegotiationneeded = () => undefined;
    publisher.onicecandidate = () => undefined; // vanilla ICE — candidates stay in the SDP
    publisher.onconnectionstatechange = () => {
      if (publisher.connectionState === "connected") {
        this.publisherIceReady = true;
        this.callbacks.onState("live");
      } else if (publisher.connectionState === "failed") {
        // The outgoing media path is dead and never heals itself — mirror the
        // subscriber-side M4 fix: the runtime's rejoin ladder rebuilds the
        // whole session with fresh candidates. The "failed" state below is
        // honest for the instant before the ladder takes over.
        this.callbacks.onState("failed", "publisher connection failed");
        if (!this.closed) {
          log.error("sfu", "publisher transport FAILED — outgoing media is dead");
          this.callbacks.onError(new PublisherTransportError());
        }
      }
    };
    if (this.micTrack) {
      this.micSender = publisher.addTrack(this.micTrack, new MediaStream([this.micTrack]));
    }

    const joinBody: Record<string, unknown> = {
      request: "join",
      room: this.room.roomId,
      ptype: "publisher",
      display: this.username,
      bitrate: PUBLISHER_BITRATE_CEILING_BPS,
    };
    if (this.room.pin) {
      joinBody.pin = this.room.pin;
    }
    const joinResult = await this.janus.send(this.publisherHandleId, joinBody);
    this.assertNoVideoroomError(joinResult.data, "publisher join");

    await this.renegotiatePublisher();
    log.info("sfu", `publisher live (mic=${this.micTrack ? "on" : "NONE"})`);
  }

  /** A/B APM probe (phase 9): swap the mic track without touching m-lines. */
  async replaceMicTrack(track: MediaStreamTrack | null): Promise<void> {
    if (this.micSender) {
      await this.micSender.replaceTrack(track);
    }
    this.micTrack = track;
  }

  getMicTrack(): MediaStreamTrack | null {
    return this.micTrack;
  }

  setMicEnabled(enabled: boolean): void {
    this.micMutedDesired = !enabled;
    if (this.micTrack) {
      this.micTrack.enabled = enabled;
    }
  }

  /**
   * Share-audio compliance: a MODERATOR mute cuts everything (the server's forced
   * layer gates the whole outgoing audio at the gateway too); a self-mute must NOT
   * kill the share audio (Discord semantics) — that split is the caller's decision.
   */
  setShareAudioEnabled(enabled: boolean): void {
    this.shareAudioMutedDesired = !enabled;
    if (this.shareAudioTrack) {
      this.shareAudioTrack.enabled = enabled;
    }
  }

  /**
   * Screen share: video FIRST, then share audio — the m-line order [mic, screen,
   * shareAudio] is the classification contract. Renegotiates once. Mutually
   * exclusive with the camera (one outgoing video m-line per member, oak parity).
   * videoBitrate — the Quality step's ceiling on the VIDEO sender (oak's
   * applyScreenBitrate); null leaves WebRTC's congestion control unbounded.
   */
  async startShare(displayStream: MediaStream, videoBitrate: number | null = null): Promise<void> {
    const videoTrack = displayStream.getVideoTracks()[0];
    const audioTrack = displayStream.getAudioTracks()[0] ?? null;
    if (!videoTrack || !this.publisherPc) {
      throw new Error("share needs a video track and a live publisher");
    }
    if (this.cameraVideoSender) {
      throw new Error("camera is already publishing — stop it before sharing a screen");
    }
    this.screenVideoSender = this.publisherPc.addTrack(videoTrack, new MediaStream([videoTrack]));
    if (videoBitrate !== null) {
      await this.raiseSenderBitrate(this.screenVideoSender, videoBitrate);
    }
    if (audioTrack) {
      this.shareAudioSender = this.publisherPc.addTrack(audioTrack, new MediaStream([audioTrack]));
      this.shareAudioTrack = audioTrack;
      this.shareAudioTrackId = audioTrack.id;
      if (this.shareAudioMutedDesired) {
        audioTrack.enabled = false; // re-shared while mod-muted — comply immediately
      }
      // The stereo killer: Opus intensity-stereo quantizes the side channel to zero at
      // low bitrates (live smoke: Δ collapsed 16.5 dB → 0.4 dB). Janus never echoes
      // maxaveragebitrate, so SendParameters.maxBitrate is the ONLY lever — raise the
      // share-audio ceiling well past voice-grade.
      await this.raiseSenderBitrate(this.shareAudioSender, 256_000);
    }
    log.info("sfu", `share started (audio=${audioTrack ? audioTrack.id : "none"}, audio bitrate ceiling 256 kbps${videoBitrate !== null ? `, video ceiling ${videoBitrate} bps` : ""})`);
    await this.renegotiatePublisher();
  }

  /** Camera publishing — a second outgoing VIDEO source riding its own m-line.
   *  videoBitrate — the Quality step's ceiling (null = unbounded, the pre-picker
   *  behavior for the toggle/diag camera paths). */
  async startCamera(cameraStream: MediaStream, videoBitrate: number | null = null): Promise<void> {
    const videoTrack = cameraStream.getVideoTracks()[0];
    if (!videoTrack || !this.publisherPc) {
      throw new Error("camera needs a video track and a live publisher");
    }
    if (this.screenVideoSender) {
      throw new Error("screen share is already publishing — stop it before starting the camera");
    }
    this.cameraVideoSender = this.publisherPc.addTrack(videoTrack, new MediaStream([videoTrack]));
    if (videoBitrate !== null) {
      await this.raiseSenderBitrate(this.cameraVideoSender, videoBitrate);
    }
    this.cameraTrack = videoTrack;
    log.info("sfu", `camera started (track ${videoTrack.id})`);
    await this.renegotiatePublisher();
  }

  async stopCamera(): Promise<void> {
    if (this.cameraTrack) {
      this.cameraTrack.stop();
      this.cameraTrack = null;
    }
    if (this.cameraVideoSender && this.publisherPc) {
      this.publisherPc.removeTrack(this.cameraVideoSender);
    }
    this.cameraVideoSender = null;
    if (this.publisherPc) {
      await this.renegotiatePublisher();
    }
  }

  isCameraPublishing(): boolean {
    return this.cameraVideoSender !== null;
  }

  /** The live local camera track — the UI's own preview binds to it. */
  getCameraTrack(): MediaStreamTrack | null {
    return this.cameraTrack;
  }

  /** The live local share video — the own-tile preview binds to it. */
  getShareTrack(): MediaStreamTrack | null {
    return this.screenVideoSender !== null ? this.screenVideoSender.track : null;
  }

  /** Best-effort maxBitrate raise on a sender (encodings may be absent pre-negotiation). */
  private async raiseSenderBitrate(sender: RTCRtpSender, maxBitrate: number): Promise<void> {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0]!.maxBitrate = maxBitrate;
      await sender.setParameters(parameters);
      log.info("sfu", `sender bitrate ceiling → ${maxBitrate} bps`);
    } catch (error: unknown) {
      log.warn("sfu", `bitrate raise failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stopShare(): Promise<void> {
    if (!this.publisherPc) {
      return;
    }
    if (this.screenVideoSender) {
      this.publisherPc.removeTrack(this.screenVideoSender);
      this.screenVideoSender = null;
    }
    if (this.shareAudioSender) {
      this.publisherPc.removeTrack(this.shareAudioSender);
      this.shareAudioSender = null;
    }
    this.shareAudioTrack = null;
    this.shareAudioTrackId = null;
    await this.renegotiatePublisher();
  }

  // ---------------------------------------------------------------------------
  // Subscriber
  // ---------------------------------------------------------------------------

  /** Which remote feed's screen we are watching (drives wanted-streams deltas). */
  setViewingFeed(feedId: number | null): void {
    this.viewedFeedIds.clear();
    if (feedId !== null) {
      this.viewedFeedIds.add(feedId);
    }
    void this.syncSubscriptions();
  }

  /** Entry point for Janus events routed from main (joined/event/attached/updated). */
  handleEvent(event: VideoroomEvent): void {
    if (this.closed) {
      return;
    }
    switch (event.kind) {
      case "joined":
      case "event": {
        if (event.publishers) {
          for (const entry of event.publishers) {
            this.recordFeed(entry);
          }
        }
        if (event.kind === "event") {
          if (event.unpublished !== undefined) {
            this.removeFeed(event.unpublished);
          }
          if (event.leaving !== undefined) {
            this.removeFeed(event.leaving);
          }
        }
        if (event.publishers?.length || (event.kind === "event" && (event.unpublished !== undefined || event.leaving !== undefined))) {
          this.callbacks.onParticipants([...this.feeds.values()]);
        }
        void this.syncSubscriptions();
        break;
      }
      case "attached":
      case "updated":
        for (const stream of event.streams) {
          this.translator.onAttached(stream.slotMid, stream.feedId, stream.streamMid);
        }
        break;
      case "error":
        if (isRoomVanished(event)) {
          this.callbacks.onError(new RoomVanishedError());
        } else if (isBadPin(event)) {
          this.callbacks.onError(new BadPinError());
        } else {
          this.callbacks.onError(new Error(`videoroom error ${event.errorCode}: ${event.errorMessage}`));
        }
        break;
      default:
        break;
    }
  }

  /** Subscriber offers arrive through the janus client's onJsep (join/subscribe answers
   *  included). Serialized by a busy-guard with a single-slot stash — latest wins. */
  async handleSubscriberOffer(jsep: JanusJsep): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.subscriberAnswerBusy) {
      this.pendingSubscriberOffer = jsep;
      return;
    }
    this.subscriberAnswerBusy = true;
    try {
      let current: JanusJsep | null = jsep;
      while (current !== null && !this.closed) {
        this.lastSubscriberOfferSdp = current.sdp;
        log.info("sdp", `WIRE offer fmtp (janus→us): ${fmtpSummary(current.sdp)}`);
        const subscriber = this.subscriberPc ?? this.createSubscriber();
        await subscriber.setRemoteDescription({ type: "offer", sdp: current.sdp });
        const answer = await subscriber.createAnswer();
        const mungedSdp = mungeStereoIntoAnswerIfOfferHasIt(answer.sdp ?? "", current.sdp);
        await subscriber.setLocalDescription({ type: "answer", sdp: mungedSdp });
        if (!this.subscriberIceReady) {
          await this.waitForGathering(subscriber);
          this.subscriberIceReady = true;
        }
        const localDescription = subscriber.localDescription;
        if (!localDescription || this.subscriberHandleId === null) {
          return;
        }
        await this.janus.send(this.subscriberHandleId, { request: "start" }, {
          type: "answer",
          sdp: localDescription.sdp ?? "",
        });
        log.info("sfu", `subscriber answer sent (${subscriber.getTransceivers().length} m-lines)`);
        current = this.pendingSubscriberOffer;
        this.pendingSubscriberOffer = null;
      }
    } catch (error: unknown) {
      log.error("sfu", `subscriber answer failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.subscriberAnswerBusy = false;
    }
  }

  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.callbacks.onState("reconnecting", "leaving");
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.cameraVideoSender = null;
    for (const [feedId, feed] of this.feeds) {
      this.teardownFeedTracks(feedId, feed.display);
    }
    this.feeds.clear();
    this.translator.clear();
    try {
      this.publisherPc?.close();
    } catch {
      // already closed
    }
    try {
      this.subscriberPc?.close();
    } catch {
      // already closed
    }
    this.publisherPc = null;
    this.subscriberPc = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private recordFeed(feed: FeedInfo): void {
    const previous = this.feeds.get(feed.feedId);
    log.info("sfu",
      `feed ${feed.feedId} "${feed.display}" streams=[${feed.streams
        .map((stream) => `${stream.type}:${stream.mid}/m${stream.mindex}${stream.disabled ? "!" : ""}`)
        .join(" ")}]${previous ? " (update)" : ""}`);
    // A stopped share announces itself as a DISABLED stream on a known mid — translate
    // that into track teardown (Janus may otherwise keep the m-line a=inactive forever).
    if (previous) {
      const classificationBefore = classifyFeed(previous);
      const classificationAfter = classifyFeed(feed);
      for (const mid of classificationBefore.videoMids) {
        if (!classificationAfter.videoMids.includes(mid) && previous.streams.find((stream) => stream.mid === mid)?.disabled) {
          this.callbacks.onRemoteTrackEnded(feed.feedId, feed.display, "video");
        }
      }
      for (const mid of classificationBefore.shareAudioMids) {
        if (!classificationAfter.shareAudioMids.includes(mid)) {
          this.callbacks.onRemoteTrackEnded(feed.feedId, feed.display, "share");
        }
      }
    }
    this.feeds.set(feed.feedId, feed);
  }

  private removeFeed(feedId: number): void {
    const feed = this.feeds.get(feedId);
    if (!feed) {
      return;
    }
    this.teardownFeedTracks(feedId, feed.display);
    this.feeds.delete(feedId);
    this.translator.forgetFeed(feedId);
    this.viewedFeedIds.delete(feedId);
    for (let index = this.pendingVideoSubscriptions.length - 1; index >= 0; index--) {
      if (this.pendingVideoSubscriptions[index]?.feedId === feedId) {
        this.pendingVideoSubscriptions.splice(index, 1);
      }
    }
    for (const key of [...this.subscribedKeys]) {
      if (key.startsWith(`${feedId}:`)) {
        this.subscribedKeys.delete(key);
      }
    }
  }

  private teardownFeedTracks(feedId: number, username: string): void {
    const feed = this.feeds.get(feedId);
    if (!feed) {
      return;
    }
    const classification = classifyFeed(feed);
    if (classification.voiceMid !== undefined) {
      this.callbacks.onRemoteTrackEnded(feedId, username, "voice");
    }
    for (const _mid of classification.shareAudioMids) {
      this.callbacks.onRemoteTrackEnded(feedId, username, "share");
    }
    for (const _mid of classification.videoMids) {
      this.callbacks.onRemoteTrackEnded(feedId, username, "video");
    }
  }

  /** The wanted-streams pump: deferred join, then subscribe/unsubscribe deltas.
   *  OWN feed is excluded — this Janus config echoes our own publisher back to us
   *  (live smoke: every client built a voice chain for its own username). */
  private async syncSubscriptions(): Promise<void> {
    if (this.closed) {
      return;
    }
    const others = [...this.feeds.values()].filter((feed) => feed.display !== this.username);
    const wanted = wantedStreams(others, this.viewedFeedIds);
    if (wanted.length === 0) {
      return; // never join with an empty streams array (429 poisons the handle)
    }
    try {
      if (!this.subscriberJoined) {
        this.subscriberHandleId = await this.janus.attach("janus.plugin.videoroom");
        this.createSubscriber();
        const joinBody: Record<string, unknown> = {
          request: "join",
          ptype: "subscriber",
          room: this.room.roomId,
          streams: wanted.map((ref) => ({ feed: ref.feed, mid: ref.mid })),
          autoupdate: false,
        };
        if (this.room.pin) {
          joinBody.pin = this.room.pin;
        }
        await this.janus.send(this.subscriberHandleId, joinBody);
        this.subscriberJoined = true;
        for (const ref of wanted) {
          this.subscribedKeys.add(streamKey(ref));
          if (this.isVideoMid(ref)) {
            this.pendingVideoSubscriptions.push({ feedId: ref.feed, mid: ref.mid });
          }
        }
        log.info("sfu", `subscriber joined with ${wanted.length} streams`);
        return;
      }
      const diff = diffSubscriptions(this.subscribedKeys, wanted);
      if (diff.subscribe.length === 0 && diff.unsubscribe.length === 0) {
        return;
      }
      for (const ref of diff.subscribe) {
        this.subscribedKeys.add(streamKey(ref));
        if (this.isVideoMid(ref)) {
          this.pendingVideoSubscriptions.push({ feedId: ref.feed, mid: ref.mid });
        }
      }
      for (const ref of diff.unsubscribe) {
        this.subscribedKeys.delete(streamKey(ref));
      }
      if (diff.subscribe.length > 0) {
        await this.janus.send(this.subscriberHandleId!, { request: "subscribe", streams: diff.subscribe.map((ref) => ({ feed: ref.feed, mid: ref.mid })) });
      }
      if (diff.unsubscribe.length > 0) {
        await this.janus.send(this.subscriberHandleId!, { request: "unsubscribe", streams: diff.unsubscribe.map((ref) => ({ feed: ref.feed, mid: ref.mid })) });
      }
      log.info("sfu", `subscriptions +${diff.subscribe.length}/-${diff.unsubscribe.length}`);
    } catch (error: unknown) {
      log.error("sfu", `subscription sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isVideoMid(ref: StreamRef): boolean {
    const feed = this.feeds.get(ref.feed);
    return feed !== undefined && classifyFeed(feed).videoMids.includes(ref.mid);
  }

  private createSubscriber(): RTCPeerConnection {
    if (this.subscriberPc) {
      return this.subscriberPc;
    }
    const subscriber = this.createPeerConnection();
    this.subscriberPc = subscriber;
    subscriber.onnegotiationneeded = () => undefined; // Janus is the offerer here
    subscriber.onicecandidate = () => undefined;
    subscriber.ontrack = (event: RTCTrackEvent) => this.routeRemoteTrack(event);
    // The incoming transport was a BLIND spot: ICE failure here meant permanent
    // silence with every log line looking healthy (live-smoke M4 — "no audio until
    // a manual re-click"). Surface the failure; the runtime climbs the rejoin ladder.
    subscriber.onconnectionstatechange = () => {
      if (subscriber.connectionState === "connected") {
        log.info("sfu", "subscriber transport connected");
      } else if (subscriber.connectionState === "failed" && !this.closed) {
        log.error("sfu", "subscriber transport FAILED — incoming media is dead");
        this.callbacks.onError(new SubscriberTransportError());
      }
    };
    return subscriber;
  }

  /** Slot mid → stream mid → classification → callback. The ONLY track-routing truth. */
  private routeRemoteTrack(event: RTCTrackEvent): void {
    const slotMid = event.transceiver.mid ?? "";
    const resolved = this.translator.resolve(slotMid);
    if (!resolved) {
      log.warn("sfu", `track on unknown slot mid ${slotMid} — dropped (no attached event yet?)`);
      return;
    }
    log.info("sfu", `remote track on slot ${slotMid} (stream ${resolved.streamMid}, feed ${resolved.feedId}, muted=${event.track.muted})`);
    const incomingTrack = event.track;
    // The muted-flag hunt (live reports: a "successful" join with dead silence
    // until a re-enter): an incoming track arrives muted ("no RTP yet") and a
    // track that NEVER unmutes plays silence forever. Log every transition and
    // flag a track still muted well after the transport connected — that
    // points at the gateway never starting the media flow for this subscription.
    incomingTrack.addEventListener("mute", () => {
      log.info("sfu", `track ${slotMid} (feed ${resolved.feedId}) → muted`);
    });
    incomingTrack.addEventListener("unmute", () => {
      log.info("sfu", `track ${slotMid} (feed ${resolved.feedId}) → UNMUTED (media flowing)`);
    });
    if (incomingTrack.muted && incomingTrack.kind === "audio") {
      setTimeout(() => {
        if (!this.closed && incomingTrack.readyState === "live" && incomingTrack.muted) {
          // A MUTED PUBLISHER sends no RTP at all — the track stays muted by design.
          // With the marks at hand the watchdog reads as "expected silence", not as
          // a dead subscription (live 2026-09-17: three "silent join" reports were
          // exactly this — the peer was mic-muted; its un-mute, not the re-enter,
          // cured the "silence").
          const display = feed?.display ?? "?";
          const muteState = feed !== undefined ? (this.callbacks.describeMuteState?.(display) ?? null) : null;
          if (muteState !== null) {
            log.info("sfu", `audio track ${slotMid} (feed ${resolved.feedId}, ${display}) still muted — expected: ${muteState}`);
          } else {
            log.warn("sfu", `audio track ${slotMid} (feed ${resolved.feedId}, ${display}) STILL muted after 5 s with NO mute mark — no RTP and the publisher should be audible: this is a real silent join`);
          }
        }
      }, 5_000);
    }
    const feedId = resolved.feedId;
    const feed = this.feeds.get(feedId);
    if (!feed) {
      log.warn("sfu", `track for unknown feed ${feedId}`);
      return;
    }
    const classification = classifyFeed(feed);
    const streamMid = resolved.streamMid;
    const track = event.track;
    if (classification.voiceMid === streamMid) {
      this.callbacks.onRemoteTrack(feedId, feed.display, "voice", track);
      return;
    }
    if (classification.shareAudioMids.includes(streamMid)) {
      this.callbacks.onRemoteTrack(feedId, feed.display, "share", track);
      return;
    }
    if (classification.videoMids.includes(streamMid)) {
      this.callbacks.onRemoteTrack(feedId, feed.display, "video", track);
      return;
    }
    // Stale slot mid reuse: bind the video track to the OLDEST pending video sub.
    const pendingIndex = this.pendingVideoSubscriptions.findIndex((entry) => entry.feedId === feedId);
    if (pendingIndex !== -1) {
      this.pendingVideoSubscriptions.splice(pendingIndex, 1);
      this.callbacks.onRemoteTrack(feedId, feed.display, "video", track);
      return;
    }
    log.warn("sfu", `unclassified track on slot ${slotMid} (stream ${streamMid}, feed ${feedId})`);
  }

  /** Explicit, serialized publisher offers (busy-guard; latest-wins re-run). */
  private async renegotiatePublisher(): Promise<void> {
    if (this.publisherOfferBusy) {
      this.publisherOfferQueued = true;
      return;
    }
    this.publisherOfferBusy = true;
    try {
      do {
        this.publisherOfferQueued = false;
        await this.publishOnce();
      } while (this.publisherOfferQueued && !this.closed);
    } finally {
      this.publisherOfferBusy = false;
    }
  }

  private async publishOnce(): Promise<void> {
    const publisher = this.publisherPc;
    if (!publisher || this.closed) {
      return;
    }
    const offer = await publisher.createOffer();
    let sdp = offer.sdp ?? "";
    if (this.shareAudioTrackId) {
      sdp = mungeStereoIntoOffer(sdp, this.shareAudioTrackId);
    }
    await publisher.setLocalDescription({ type: "offer", sdp });
    if (!this.publisherIceReady) {
      await this.waitForGathering(publisher);
      this.publisherIceReady = true;
    }
    const localDescription = publisher.localDescription;
    if (!localDescription) {
      throw new Error("publisher localDescription missing");
    }
    if (this.shareAudioTrackId) {
      log.info("sdp", `SENT offer fmtp: ${fmtpSummary(localDescription.sdp ?? "")}`);
    }
    const answer = await this.janus.send(this.publisherHandleId,
      // `bitrate` re-asserts the REMB ceiling on every (re)negotiation — the
      // join-level value covers the session, this one survives any plugin
      // restart of the publisher state.
      { request: "configure", audio: true, video: true, bitrate: PUBLISHER_BITRATE_CEILING_BPS },
      { type: "offer", sdp: localDescription.sdp ?? "" });
    this.assertNoVideoroomError(answer.data, "publish");
    if (answer.jsep) {
      await publisher.setRemoteDescription({ type: answer.jsep.type as RTCSdpType, sdp: answer.jsep.sdp });
      if (this.shareAudioTrackId) {
        log.info("sdp", `JANUS answer fmtp: ${fmtpSummary(answer.jsep.sdp)}`);
      }
    }
  }

  /** Vanilla ICE: wait until candidates are IN the SDP (bounded — 2 s cap). */
  private waitForGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          finish();
        }
      };
      const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private assertNoVideoroomError(data: unknown, what: string): void {
    if (data !== null && typeof data === "object" && "error_code" in (data as Record<string, unknown>)) {
      const record = data as { error_code: number; error?: string };
      log.error("sfu", `${what} rejected: ${record.error_code} ${record.error ?? ""}`);
      if (record.error_code === 426) {
        throw new RoomVanishedError();
      }
      if (record.error_code === 433) {
        throw new BadPinError();
      }
      throw new Error(`videoroom ${what} failed: ${record.error_code}`);
    }
  }

  /** Diagnostics surface. */
  getLastSubscriberOfferSdp(): string | null {
    return this.lastSubscriberOfferSdp;
  }

  getSubscriberConnectionState(): string {
    return this.subscriberPc?.connectionState ?? "none";
  }

  /** The room this session lives in — the pop-out viewer opens its own
   *  subscription against the same room (token/pin included). */
  getRoom(): RoomInfo {
    return this.room;
  }

  getPublisherLocalSdp(): string | null {
    return this.publisherPc?.localDescription?.sdp ?? null;
  }

  /** Wire-level oracle: inbound audio RTP levels/bytes from the subscriber PC.
   *  Distinguishes "RTP flows but playout is dead" from "no RTP at all". */
  async getInboundAudioLine(): Promise<string> {
    if (!this.subscriberPc) {
      return "—";
    }
    try {
      const report = await this.subscriberPc.getStats();
      const parts: string[] = [];
      report.forEach((stat) => {
        if (stat.type !== "inbound-rtp" || stat.kind !== "audio") {
          return;
        }
        const record = stat as unknown as Record<string, unknown>;
        const audioLevel = typeof record.audioLevel === "number" ? record.audioLevel.toFixed(3) : "?";
        const bytes = typeof record.bytesReceived === "number" ? record.bytesReceived : 0;
        parts.push(`lvl=${audioLevel} bytes=${bytes}`);
      });
      return parts.length > 0 ? parts.join(" | ") : "no inbound audio";
    } catch {
      return "stats error";
    }
  }

  /** Share-video OUT counters (publisher side): capture input fps, encoded
   *  frames, bytes — the "encoder starvation" evidence behind choppy-viewer
   *  reports (input 75 while enc ≈ 20 = the encoder cannot keep up). Null
   *  when no share is publishing. */
  async getShareOutCounters(): Promise<VideoRtpCounters | null> {
    const sender = this.screenVideoSender;
    if (!this.publisherPc || sender === null) {
      return null;
    }
    const trackIdentifier = sender.track?.id;
    if (trackIdentifier === undefined) {
      return null;
    }
    try {
      const report = await this.publisherPc.getStats();
      const pair = videoEntriesForTrack(report, "outbound-rtp", trackIdentifier);
      if (pair === null) {
        return null;
      }
      return {
        timestamp: numberOrNull(pair.rtp.timestamp) ?? 0,
        bytes: numberOrNull(pair.rtp.bytesSent) ?? 0,
        frames: numberOrNull(pair.rtp.framesEncoded) ?? 0,
        framesPerSecond: numberOrNull(pair.track.framesPerSecond),
        width: numberOrNull(pair.track.frameWidth),
        height: numberOrNull(pair.track.frameHeight),
        framesDropped: null,
        packetsLost: null,
        jitterMs: null,
      };
    } catch {
      return null;
    }
  }

  /** Share-video IN counters (viewer side) for one receiving track: decoded
   *  fps, dropped frames, loss, jitter. Null when the track receives nothing
   *  (not subscribed yet / video muted upstream). */
  async getInboundVideoCounters(trackId: string): Promise<VideoRtpCounters | null> {
    if (!this.subscriberPc) {
      return null;
    }
    try {
      const report = await this.subscriberPc.getStats();
      const pair = videoEntriesForTrack(report, "inbound-rtp", trackId);
      if (pair === null) {
        return null;
      }
      const jitterSeconds = numberOrNull(pair.rtp.jitter);
      return {
        timestamp: numberOrNull(pair.rtp.timestamp) ?? 0,
        bytes: numberOrNull(pair.rtp.bytesReceived) ?? 0,
        frames: numberOrNull(pair.rtp.framesDecoded) ?? 0,
        framesPerSecond: numberOrNull(pair.track.framesPerSecond),
        width: numberOrNull(pair.track.frameWidth),
        height: numberOrNull(pair.track.frameHeight),
        framesDropped: numberOrNull(pair.track.framesDropped),
        packetsLost: numberOrNull(pair.rtp.packetsLost),
        jitterMs: jitterSeconds !== null ? jitterSeconds * 1000 : null,
      };
    } catch {
      return null;
    }
  }

  getSubscribedCount(): number {
    return this.subscribedKeys.size;
  }
}
