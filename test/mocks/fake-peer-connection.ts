/**
 * Minimal RTCPeerConnection double: canned SDP answers, controllable gathering state,
 * ontrack/onconnectionstatechange drivers. Only the surface SfuSession touches.
 */
export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly senders: { track: unknown }[] = [];
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  private gatheringListeners: (() => void)[] = [];

  /** How many createOffer rounds completed (busy-guard serialization observable). */
  offerCount = 0;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: unknown, _stream: unknown): { track: unknown } {
    const sender = { track };
    this.senders.push(sender);
    this.onnegotiationneeded?.();
    return sender;
  }

  removeTrack(sender: { track: unknown }): void {
    const index = this.senders.indexOf(sender);
    if (index !== -1) {
      this.senders.splice(index, 1);
    }
    this.onnegotiationneeded?.();
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const audioCount = this.senders.length;
    this.offerCount += 1;
    return { type: "offer", sdp: `v=0\nm=audio x${audioCount}\n` };
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

  close(): void {
    this.connectionState = "closed";
  }
}

export function resetFakePeerConnections(): void {
  FakePeerConnection.instances = [];
}

/** A stand-in track with an id (the msid-munge key). */
export function fakeTrack(id: string): { id: string; kind: string; enabled: boolean; stop(): void } {
  return {
    id,
    kind: id.startsWith("audio") ? "audio" : "video",
    enabled: true,
    stop: () => undefined,
  };
}
