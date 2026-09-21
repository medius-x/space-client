import type { RoomInfo } from "../types";
import { log } from "../logging";
import { JanusClient, type JanusClientOptions, type JanusJsep } from "./janus";

/**
 * The share pop-out window's own videoroom subscription (2026-09-21, replacing
 * the M4 JPEG relay): a MediaStream cannot cross Electron renderer contexts,
 * but a SECOND subscriber can — the pop-out window opens its own Janus REST
 * session and subscribes to the watched feed's VIDEO stream only (the main
 * window already plays the share audio; a second audio subscription would
 * double it). Full quality and frame rate, zero per-frame cost in the main
 * window — the JPEG pump topped out at 12.5 fps by design.
 *
 * The flow mirrors SfuSession's subscriber half: attach videoroom → join
 * {ptype: subscriber, streams: [{feed, mid}]} → Janus offers (vanilla ICE) →
 * answer → "start" → ontrack.
 */

export interface PopoutViewerOptions {
  room: RoomInfo;
  feedId: number;
  /** The feed's VIDEO stream mid (the subscription is video-only). */
  videoMid: string;
  onTrack(track: MediaStreamTrack): void;
  /** The feed went away (track ended / transport failed / janus session
   *  lost / negotiation failed) — the pop-out shows its waiting state. */
  onGone(): void;
  /** Test seams (the SfuSession mediaSource/peerConnectionImpl pattern). */
  janusFactory?(options: JanusClientOptions): JanusClient;
  peerConnectionImpl?: typeof RTCPeerConnection;
}

const GATHERING_TIMEOUT_MS = 2_000;

export class PopoutViewer {
  private readonly options: PopoutViewerOptions;
  private readonly janus: JanusClient;
  private readonly createPeerConnection: () => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private handleId: number | null = null;
  private closed = false;
  private goneFired = false;

  constructor(options: PopoutViewerOptions) {
    this.options = options;
    const peerConnectionImpl = options.peerConnectionImpl ?? RTCPeerConnection;
    this.createPeerConnection = () => new peerConnectionImpl();
    this.janus = (options.janusFactory ?? ((janusOptions) => new JanusClient(janusOptions)))({
      baseUrl: options.room.janusUrl,
      token: options.room.token,
      pin: options.room.pin,
      roomId: options.room.roomId,
      onEvent: () => undefined, // a single-subscription viewer needs no plugin events
      onJsep: (_handleId, jsep) => {
        if (jsep.type === "offer") {
          void this.handleOffer(jsep);
        }
      },
      onSessionLost: (reason) => this.fireGone(`janus session lost (${reason})`),
    });
  }

  async start(): Promise<void> {
    await this.janus.open();
    this.handleId = await this.janus.attach("janus.plugin.videoroom");
    const joinBody: Record<string, unknown> = {
      request: "join",
      ptype: "subscriber",
      room: this.options.room.roomId,
      streams: [{ feed: this.options.feedId, mid: this.options.videoMid }],
      autoupdate: false,
    };
    if (this.options.room.pin) {
      joinBody.pin = this.options.room.pin;
    }
    await this.janus.send(this.handleId, joinBody);
    log.info("popout", `subscriber join sent (feed ${this.options.feedId}, mid ${this.options.videoMid})`);
  }

  private createPc(): RTCPeerConnection {
    const pc = this.createPeerConnection(); // EMPTY config — host candidates, the gateway is local
    this.pc = pc;
    pc.onnegotiationneeded = () => undefined; // Janus is the offerer here
    pc.onicecandidate = () => undefined;
    pc.ontrack = (event) => {
      event.track.addEventListener("ended", () => this.fireGone("track ended"));
      if (!this.closed) {
        this.options.onTrack(event.track);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        log.info("popout", "transport connected");
      }
      if (pc.connectionState === "failed") {
        this.fireGone("transport failed");
      }
    };
    return pc;
  }

  private async handleOffer(jsep: JanusJsep): Promise<void> {
    if (this.closed || this.handleId === null) {
      return;
    }
    try {
      const pc = this.pc ?? this.createPc();
      await pc.setRemoteDescription({ type: "offer", sdp: jsep.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc.iceGatheringState !== "complete") {
        await this.waitForGathering(pc);
      }
      const localDescription = pc.localDescription;
      if (!localDescription) {
        return;
      }
      await this.janus.send(this.handleId, { request: "start" }, { type: "answer", sdp: localDescription.sdp ?? "" });
      log.info("popout", "subscriber answer sent");
    } catch (error: unknown) {
      log.error("popout", `negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
      this.fireGone("negotiation failed");
    }
  }

  private waitForGathering(pc: RTCPeerConnection): Promise<void> {
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
      const timer = setTimeout(finish, GATHERING_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private fireGone(reason: string): void {
    if (this.closed || this.goneFired) {
      return;
    }
    this.goneFired = true;
    log.warn("popout", `viewer gone: ${reason}`);
    this.options.onGone();
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.pc = null;
    void this.janus.destroy().catch(() => undefined);
  }
}
