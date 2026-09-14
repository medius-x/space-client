import { log } from "../logging";
import type { CallIceCandidate, CallSignal, IncomingCallSignal } from "../types";
import { iceRestartDelayMs, planIceRestart } from "../domain/logic/ice-restart";
import { mungeStereoIntoAnswerIfOfferHasIt, mungeStereoIntoOffer, sectionMids } from "./sdp";

/**
 * One 1:1 WebRTC call against a peer — the design the oak client converged on,
 * rebuilt for Chromium (where the second audio m-line that killed webrtc-java
 * just works):
 *
 *  - m-line CONTRACT, fixed in the initial offer and NEVER renegotiated:
 *    [0] voice audio (mic track from the start), [1] video (camera OR screen),
 *    [2] share audio (system loopback of the shared screen). Camera and screen
 *    switches are replaceTrack on the pre-negotiated senders — zero SDP exchange
 *    mid-call, zero glare.
 *  - stereo=1 is munged into the LAST m=audio section of the initial offer (the
 *    share audio); replaceTrack does not touch SDP, so the codec parameters
 *    negotiated once keep stereo alive for the whole call.
 *  - Trickle ICE over /app/call.signal; candidates arriving before the remote
 *    description are buffered and drained after setRemoteDescription.
 *  - ICE restarts are CALLER-only (the RING/ACCEPT handshake fixes the role, so
 *    glare is impossible): caller climbs 1→2→4→8→16 s forever; the callee just
 *    answers a restart offer in place (handleSignal OFFER is stateless).
 */

export type PeerTrackKind = "voice" | "video" | "share";

export interface PeerCallOptions {
  isCaller: boolean;
  peerUsername: string;
  iceServers: RTCIceServer[];
  /** The caller's mic stream, captured by the runtime before the session exists. */
  micStream: MediaStream;
  peerConnectionImpl?: typeof RTCPeerConnection;
  sendSignal(signal: CallSignal): void;
  callbacks: {
    onRemoteTrack(kind: PeerTrackKind, track: MediaStreamTrack): void;
    onRemoteTrackEnded(kind: PeerTrackKind): void;
    onPeerMic(enabled: boolean): void;
    onPeerDeafened(enabled: boolean): void;
    onPeerCamera(enabled: boolean): void;
    onPeerScreen(enabled: boolean): void;
    /** false = the media path is being rebuilt ("Reconnecting…"); true = healthy. */
    onConnectionHealth(healthy: boolean): void;
    onNegotiated(): void;
    onError(message: string): void;
  };
}

const SHARE_AUDIO_BITRATE_BPS = 256_000;

/** The m-line index of each pre-negotiated track slot. */
const MLINE_VOICE = 0;
const MLINE_VIDEO = 1;
const MLINE_SHARE_AUDIO = 2;

export class PeerCallSession {
  private readonly isCaller: boolean;
  private readonly peerUsername: string;
  private readonly sendSignalOut: (signal: CallSignal) => void;
  private readonly callbacks: PeerCallOptions["callbacks"];
  private readonly peerConnection: RTCPeerConnection;
  private readonly micTrack: MediaStreamTrack | null;

  private videoSender: RTCRtpSender | null = null;
  private shareAudioSender: RTCRtpSender | null = null;
  private micEnabled = true;
  private deafened = false;
  private cameraActive = false;
  private screenActive = false;
  private negotiated = false;
  private closed = false;
  /** Remote candidates that arrived before setRemoteDescription — drained after. */
  private pendingIce: CallIceCandidate[] = [];
  /** Tracks already handed to the UI (passive binds re-run on every remote description). */
  private readonly boundRemoteTracks = new Set<MediaStreamTrack>();
  /**
   * The a=mid of each m-line slot, resolved from the NEGOTIATED SDP. The array
   * index of pc.getTransceivers() is NOT the slot: on SRD Chromium may skip our
   * pre-created empty transceivers and add its own (live M5 smoke — tracks arrived
   * on array slots 3/4 while our senders sat on dead m-lines). Mids are stable.
   */
  private slotMids: [string | null, string | null, string | null] = [null, null, null];
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartAttempt = 0;

  constructor(options: PeerCallOptions) {
    this.isCaller = options.isCaller;
    this.peerUsername = options.peerUsername;
    this.sendSignalOut = options.sendSignal;
    this.callbacks = options.callbacks;
    const PeerConnectionClass = options.peerConnectionImpl ?? RTCPeerConnection;
    this.peerConnection = new PeerConnectionClass({ iceServers: options.iceServers });
    this.micTrack = options.micStream.getAudioTracks()[0] ?? null;
    // A PRE-ACCEPT mute (the runtime gates the captured track while the callee
    // is still ringing) must survive the session: read the gate, don't assume on.
    this.micEnabled = this.micTrack?.enabled ?? true;

    // The m-line contract: voice carries the real track; video and share audio are
    // pre-negotiated EMPTY sendrecv slots activated later by replaceTrack.
    if (this.micTrack) {
      this.peerConnection.addTrack(this.micTrack, options.micStream);
    } else {
      this.peerConnection.addTransceiver("audio", { direction: "sendrecv" });
    }
    this.videoSender = this.peerConnection.addTransceiver("video", { direction: "sendrecv" }).sender;
    this.shareAudioSender = this.peerConnection.addTransceiver("audio", { direction: "sendrecv" }).sender;

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signal({
          type: "ICE",
          sdp: null,
          candidate: {
            sdp: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      }
    };
    this.peerConnection.ontrack = (event) => this.routeRemoteTrack(event);
    this.peerConnection.onconnectionstatechange = () => this.handleConnectionState();
  }

  getPeerConnectionState(): RTCPeerConnectionState {
    return this.peerConnection.connectionState;
  }

  /** The caller's half of the handshake (sent right after the callee's ACCEPT). */
  async startOffer(): Promise<void> {
    await this.publishOffer(false);
    log.info("call", `offer sent to ${this.peerUsername} (caller)`);
  }

  /** Resolve an m-line slot to its a=mid, then to the LIVE transceiver sender. */
  private senderForSlot(slot: number): RTCRtpSender | null {
    const mid = this.slotMids[slot];
    if (mid !== null) {
      const transceiver = this.peerConnection.getTransceivers().find((entry) => entry.mid === mid);
      if (transceiver) {
        return transceiver.sender;
      }
    }
    return slot === MLINE_VIDEO ? this.videoSender : this.shareAudioSender;
  }

  /** Adopt the mids of the negotiated description; log the transceiver layout. */
  private adoptMids(sdp: string, what: string): void {
    const mids = sectionMids(sdp);
    this.slotMids = [mids[MLINE_VOICE] ?? null, mids[MLINE_VIDEO] ?? null, mids[MLINE_SHARE_AUDIO] ?? null];
    const layout = this.peerConnection.getTransceivers()
      .map((entry) => `${entry.mid ?? "?"}=${entry.sender.track ? "send" : "idle"}`)
      .join(" ");
    log.info("call", `mids from ${what}: voice=${this.slotMids[0]} video=${this.slotMids[1]} share=${this.slotMids[2]} | transceivers: ${layout}`);
  }

  /** Route one incoming signal (the runtime feeds every /user/queue/call.signal push). */
  async handleSignal(signal: IncomingCallSignal): Promise<void> {
    if (this.closed) {
      return;
    }
    switch (signal.type) {
      case "OFFER":
        await this.answerOffer(signal.sdp);
        return;
      case "ANSWER":
        await this.peerConnection.setRemoteDescription({ type: "answer", sdp: signal.sdp ?? "" });
        this.adoptMids(signal.sdp ?? "", "answer");
        this.drainPendingIce();
        this.bindPassiveReceiverSlots();
        return;
      case "ICE":
        if (signal.candidate === null) {
          return;
        }
        if (this.peerConnection.remoteDescription === null) {
          this.pendingIce.push(signal.candidate); // candidates can beat the answer
          return;
        }
        await this.addIceCandidate(signal.candidate);
        return;
      case "MIC_ON":
        this.callbacks.onPeerMic(true);
        return;
      case "MIC_OFF":
        this.callbacks.onPeerMic(false);
        return;
      case "DEAFEN_ON":
        this.callbacks.onPeerDeafened(true);
        return;
      case "DEAFEN_OFF":
        this.callbacks.onPeerDeafened(false);
        return;
      case "CAM_ON":
        this.callbacks.onPeerCamera(true);
        return;
      case "CAM_OFF":
        this.callbacks.onPeerCamera(false);
        return;
      case "SCREEN_ON":
        this.callbacks.onPeerScreen(true);
        return;
      case "SCREEN_OFF":
        this.callbacks.onPeerScreen(false);
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Local media toggles — replaceTrack only, never a renegotiation
  // ---------------------------------------------------------------------------

  setMicEnabled(enabled: boolean): void {
    if (this.micTrack) {
      this.micTrack.enabled = enabled;
    }
    this.micEnabled = enabled;
    this.signal({ type: enabled ? "MIC_ON" : "MIC_OFF", sdp: null, candidate: null });
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  /**
   * Call-local deafen: silences OUR playout (the runtime's RoomAudio) and implies a
   * mic gate — a deafened member must not keep broadcasting (oak semantics). The
   * DEAFEN signal is UI-only: there is no server voice-control in P2P.
   */
  setDeafened(enabled: boolean): void {
    this.deafened = enabled;
    this.signal({ type: enabled ? "DEAFEN_ON" : "DEAFEN_OFF", sdp: null, candidate: null });
  }

  /** Camera on/off: swaps the video slot's track. */
  async setCameraStream(cameraStream: MediaStream | null): Promise<void> {
    const track = cameraStream?.getVideoTracks()[0] ?? null;
    await this.senderForSlot(MLINE_VIDEO)?.replaceTrack(track);
    this.cameraActive = track !== null;
    this.signal({ type: track !== null ? "CAM_ON" : "CAM_OFF", sdp: null, candidate: null });
  }

  isCameraActive(): boolean {
    return this.cameraActive;
  }

  /** Screen share: video slot + the SECOND audio slot (stereo system loopback). */
  async startShare(displayStream: MediaStream): Promise<void> {
    const videoTrack = displayStream.getVideoTracks()[0] ?? null;
    const audioTrack = displayStream.getAudioTracks()[0] ?? null;
    await this.senderForSlot(MLINE_VIDEO)?.replaceTrack(videoTrack);
    await this.senderForSlot(MLINE_SHARE_AUDIO)?.replaceTrack(audioTrack);
    await this.raiseShareBitrate();
    this.screenActive = true;
    this.signal({ type: "SCREEN_ON", sdp: null, candidate: null });
    log.info("call", `share started (audio=${audioTrack ? audioTrack.id : "none"})`);
  }

  async stopShare(): Promise<void> {
    await this.senderForSlot(MLINE_VIDEO)?.replaceTrack(null);
    await this.senderForSlot(MLINE_SHARE_AUDIO)?.replaceTrack(null);
    this.screenActive = false;
    this.signal({ type: "SCREEN_OFF", sdp: null, candidate: null });
  }

  isSharing(): boolean {
    return this.screenActive;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.iceRestartTimer !== null) {
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
    try {
      this.peerConnection.close();
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private signal(body: Omit<CallSignal, "to">): void {
    this.sendSignalOut({ ...body, to: this.peerUsername });
  }

  private async publishOffer(iceRestart: boolean): Promise<void> {
    const offer = await this.peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
    // The share audio is the LAST m=audio of the offer — munge stereo there.
    const mungedSdp = mungeStereoIntoOffer(offer.sdp ?? "", "");
    await this.peerConnection.setLocalDescription({ type: "offer", sdp: mungedSdp });
    if (!iceRestart) {
      this.adoptMids(mungedSdp, "local offer");
    }
    this.signal({ type: "OFFER", sdp: mungedSdp, candidate: null });
  }

  /** Callee (or callee-side of a caller's ICE restart): answer any offer in place. */
  private async answerOffer(sdp: string | null): Promise<void> {
    await this.peerConnection.setRemoteDescription({ type: "offer", sdp: sdp ?? "" });
    this.adoptMids(sdp ?? "", "offer");
    const answer = await this.peerConnection.createAnswer();
    const mungedAnswer = mungeStereoIntoAnswerIfOfferHasIt(answer.sdp ?? "", sdp ?? "");
    await this.peerConnection.setLocalDescription({ type: "answer", sdp: mungedAnswer });
    this.signal({ type: "ANSWER", sdp: mungedAnswer, candidate: null });
    this.drainPendingIce();
    this.bindPassiveReceiverSlots();
  }

  private async addIceCandidate(candidate: CallIceCandidate): Promise<void> {
    try {
      await this.peerConnection.addIceCandidate({
        candidate: candidate.sdp,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    } catch (error: unknown) {
      // A candidate for a dead m-line or a stale restart round — never fatal.
      log.warn("call", `ice candidate rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private drainPendingIce(): void {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of queued) {
      void this.addIceCandidate(candidate);
    }
  }

  /** Track routing: ontrack is only authoritative for the VOICE slot (its track
   *  was in the offer from the start); the empty slots fire no ontrack ever when the
   *  peer activates them via replaceTrack — those are bound passively instead. */
  private routeRemoteTrack(event: RTCTrackEvent): void {
    const slot = this.slotOf(event.transceiver);
    if (slot === MLINE_VOICE) {
      if (this.boundRemoteTracks.has(event.track)) {
        return;
      }
      this.boundRemoteTracks.add(event.track);
      this.callbacks.onRemoteTrack("voice", event.track);
      event.track.addEventListener("ended", () => {
        this.callbacks.onRemoteTrackEnded("voice");
      });
      return;
    }
    if (slot === MLINE_VIDEO || slot === MLINE_SHARE_AUDIO) {
      return; // passively bound
    }
    log.warn("call", `remote track outside the slot contract (slot ${slot}, mid ${event.transceiver.mid ?? "?"}) — dropped`);
  }

  /**
   * THE activation path for the empty slots: after every setRemoteDescription, hand
   * the UI the receiver tracks of the video/share m-lines. They are muted until the
   * peer's replaceTrack starts the RTP — then Chromium flips them live and the
   * already-bound elements start playing. Without this the remote side stays BLACK
   * (live M5 smoke: replaceTrack on an msid-less slot is invisible to ontrack).
   */
  private bindPassiveReceiverSlots(): void {
    const bind = (slot: number, kind: PeerTrackKind): void => {
      const mid = this.slotMids[slot];
      const transceiver = mid !== null
        ? this.peerConnection.getTransceivers().find((entry) => entry.mid === mid)
        : this.peerConnection.getTransceivers()[slot];
      const track = transceiver?.receiver.track;
      if (!transceiver || !track) {
        log.warn("call", `no receiver for slot ${slot} (mid ${mid ?? "?"}) — ${kind} stays unbound`);
        return;
      }
      if (this.boundRemoteTracks.has(track)) {
        return;
      }
      this.boundRemoteTracks.add(track);
      this.callbacks.onRemoteTrack(kind, track);
    };
    bind(MLINE_VIDEO, "video");
    bind(MLINE_SHARE_AUDIO, "share");
  }

  /** Slot by a=mid first (the stable identity), array index only as a last resort. */
  private slotOf(transceiver: RTCRtpTransceiver): number {
    if (transceiver.mid !== null) {
      const byMid = this.slotMids.indexOf(transceiver.mid);
      if (byMid !== -1) {
        return byMid;
      }
    }
    return this.peerConnection.getTransceivers().indexOf(transceiver);
  }

  private handleConnectionState(): void {
    if (this.closed) {
      return;
    }
    const state = this.peerConnection.connectionState;
    const plan = planIceRestart(this.isCaller, state);
    if (state === "connected" && !this.negotiated) {
      this.negotiated = true;
      this.iceRestartAttempt = 0;
      this.callbacks.onNegotiated();
    }
    switch (plan) {
      case "schedule-restart":
        this.callbacks.onConnectionHealth(false);
        this.scheduleIceRestart();
        return;
      case "await-caller-restart":
        this.callbacks.onConnectionHealth(false);
        return;
      case "reset-backoff":
        this.iceRestartAttempt = 0;
        if (this.negotiated) {
          this.callbacks.onConnectionHealth(true);
        }
        return;
      default:
        return; // new/checking/disconnected — brief blips heal themselves
    }
  }

  private scheduleIceRestart(): void {
    if (this.iceRestartTimer !== null || this.closed) {
      return;
    }
    this.iceRestartAttempt += 1;
    const delayMs = iceRestartDelayMs(this.iceRestartAttempt);
    log.warn("call", `ICE failed — restart ${this.iceRestartAttempt} in ${delayMs} ms (caller-only ladder)`);
    this.iceRestartTimer = setTimeout(() => {
      this.iceRestartTimer = null;
      if (this.closed) {
        return;
      }
      void this.publishOffer(true).catch((error: unknown) => {
        this.callbacks.onError(error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
  }

  /** The stereo killer fix from the SFU work, applied to the share-audio sender. */
  private async raiseShareBitrate(): Promise<void> {
    const sender = this.senderForSlot(MLINE_SHARE_AUDIO);
    if (!sender) {
      return;
    }
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0]!.maxBitrate = SHARE_AUDIO_BITRATE_BPS;
      await sender.setParameters(parameters);
    } catch (error: unknown) {
      log.warn("call", `share bitrate raise failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
