/**
 * Minimal RTCPeerConnection double: canned SDP answers, controllable gathering state,
 * ontrack/onconnectionstatechange drivers, transceivers/senders for the P2P call
 * (replaceTrack/ICE). Only the surface SfuSession and PeerCallSession touch.
 */

export interface FakeSender {
  track: unknown;
  replaceTrack(track: unknown): Promise<void>;
  /** Optional scripted stats source for the uplink-watchdog tests
   *  (outbound-rtp entries with bytesSent). */
  getStats?(): Promise<Map<string, unknown>>;
}

export interface FakeTransceiver {
  mid: string | null;
  kind: string;
  direction: string;
  sender: FakeSender;
  receiver: { track: unknown };
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  /** ICE candidates fed through addIceCandidate (order preserved). */
  readonly iceCandidates: unknown[] = [];

  readonly senders: FakeSender[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  private gatheringListeners: (() => void)[] = [];
  private nextMid = 0;

  /** How many createOffer rounds completed (busy-guard serialization observable). */
  offerCount = 0;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: unknown, _stream: unknown): FakeSender {
    const sender: FakeSender = {
      track,
      replaceTrack: async (replacement: unknown) => {
        sender.track = replacement;
      },
    };
    this.senders.push(sender);
    this.transceivers.push({
      mid: this.claimMid(),
      kind: "audio", // addTrack in our code is only ever the mic
      direction: "sendrecv",
      sender,
      receiver: { track: fakeTrack("recv-voice") },
    });
    this.onnegotiationneeded?.();
    return sender;
  }

  addTransceiver(kindOrTrack: string | unknown, init?: { direction?: RTCRtpTransceiverDirection }): FakeTransceiver {
    const kind = typeof kindOrTrack === "string" ? kindOrTrack : "video";
    const transceiver: FakeTransceiver = {
      mid: this.claimMid(),
      kind,
      direction: init?.direction ?? "sendrecv",
      sender: {
        track: null,
        replaceTrack: async (replacement: unknown) => {
          transceiver.sender.track = replacement;
        },
      },
      // Real receivers own a (muted) track from the moment the m-line is negotiated —
      // the passive-binding path depends on it.
      receiver: { track: fakeTrack(`recv-${kind}`) },
    };
    this.transceivers.push(transceiver);
    this.onnegotiationneeded?.();
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.transceivers];
  }

  private claimMid(): string {
    const mid = String(this.nextMid);
    this.nextMid += 1;
    return mid;
  }

  removeTrack(sender: FakeSender): void {
    const index = this.senders.indexOf(sender);
    if (index !== -1) {
      this.senders.splice(index, 1);
    }
    const transceiverIndex = this.transceivers.findIndex((entry) => entry.sender === sender);
    if (transceiverIndex !== -1) {
      this.transceivers.splice(transceiverIndex, 1);
    }
    this.onnegotiationneeded?.();
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const senderCount = this.senders.length + this.transceivers.length;
    this.offerCount += 1;
    return { type: "offer", sdp: `v=0\nm=audio x${senderCount}\n` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\nm=audio answer\n" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    // Complete gathering on the next microtask unless a test holds it back.
    if (this.gatheringHold) {
      return;
    }
    this.completeGathering();
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    if (description.type !== "offer") {
      return;
    }
    // Emulate the JSEP offer processing Chromium performs: every m-section NOT
    // covered by an existing transceiver (by mid) gets a FRESH recvonly one —
    // empty pre-created transceivers are NOT reused (live smoke 2026-10-08:
    // the callee's own video/share slots stayed unassociated, Chromium made
    // its own, and the callee's share RTP never left the machine).
    for (const section of offerMSections(description.sdp ?? "")) {
      if (this.transceivers.some((entry) => entry.mid === section.mid)) {
        continue;
      }
      const transceiver: FakeTransceiver = {
        mid: section.mid,
        kind: section.kind,
        direction: "recvonly",
        sender: { track: null, replaceTrack: async () => undefined },
        receiver: { track: fakeTrack(`recv-${section.kind}-${section.mid}`) },
      };
      transceiver.sender.replaceTrack = async (replacement: unknown) => {
        transceiver.sender.track = replacement;
      };
      this.transceivers.push(transceiver);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.iceCandidates.push(candidate);
  }

  gatheringHold = false;

  completeGathering(): void {
    if (this.iceGatheringState === "complete") {
      return;
    }
    this.iceGatheringState = "complete";
    for (const listener of [...this.gatheringListeners]) {
      listener();
    }
  }

  addEventListener(_type: string, listener: () => void): void {
    this.gatheringListeners.push(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.gatheringListeners = this.gatheringListeners.filter((entry) => entry !== listener);
  }

  driveConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  driveOnTrack(transceiverMid: string, track: unknown): void {
    const event = {
      transceiver: { mid: transceiverMid },
      track,
      streams: [],
    } as unknown as RTCTrackEvent;
    this.ontrack?.(event);
  }

  /** Like driveOnTrack but with a REAL transceiver from this PC (slot routing). */
  driveOnTrackOn(transceiver: FakeTransceiver, track: unknown): void {
    const event = {
      transceiver,
      track,
      streams: [],
    } as unknown as RTCTrackEvent;
    this.ontrack?.(event);
  }

  /** Emulates a transceiver that a PREVIOUS remote offer created (a recycled m-line:
   *  it exists before any new offer, carrying the same receiver track Chromium keeps).
   *  The passive-binding path reads it through getTransceivers() — no ontrack involved. */
  seedRemoteTransceiver(mid: string, track: unknown): FakeTransceiver {
    const transceiver: FakeTransceiver = {
      mid,
      kind: "audio",
      direction: "recvonly",
      sender: { track: null, replaceTrack: async () => undefined },
      receiver: { track },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  /** Emit an ICE candidate through onicecandidate (the trickle path). */
  driveIceCandidate(candidate: string): void {
    const event = {
      candidate: { candidate, sdpMid: "0", sdpMLineIndex: 0 },
    } as unknown as RTCPeerConnectionEventMap["icecandidate"];
    this.onicecandidate?.(event);
  }

  close(): void {
    this.connectionState = "closed";
  }
}

export function resetFakePeerConnections(): void {
  FakePeerConnection.instances = [];
}

/** m= sections with their a=mid of an offer SDP (the shape the peer-call tests
 *  write); sections without a mid are dropped — a fake without a mid has no
 *  identity to create a transceiver for. */
function offerMSections(sdp: string): { kind: string; mid: string }[] {
  const sections: { kind: string; mid: string }[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const mediaMatch = /^m=(\w+)/.exec(line);
    if (mediaMatch !== null) {
      sections.push({ kind: mediaMatch[1]!, mid: "" });
      continue;
    }
    const midMatch = /^a=mid:(\S+)/.exec(line);
    if (midMatch !== null && sections.length > 0 && sections[sections.length - 1]!.mid === "") {
      sections[sections.length - 1]!.mid = midMatch[1]!;
    }
  }
  return sections.filter((section) => section.mid !== "");
}

/** A stand-in track with an id (the msid-munge key). */
export function fakeTrack(id: string): { id: string; kind: string; enabled: boolean; stop(): void; addEventListener(type: string, listener: () => void): void } {
  return {
    id,
    kind: id.startsWith("audio") ? "audio" : "video",
    enabled: true,
    stop: () => undefined,
    addEventListener: (_type: string, _listener: () => void) => undefined,
  };
}
