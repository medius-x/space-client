import { describe, expect, it, vi } from "vitest";
import { PopoutViewer } from "../src/core/popout-viewer";
import type { JanusClientOptions, JanusClient } from "../src/core/janus";

/** Captures the Janus surface PopoutViewer uses; test drives it by hand. */
class FakeJanus {
  options!: JanusClientOptions;
  opened = 0;
  destroyed = 0;
  attachedPlugins: string[] = [];
  sends: { handleId: number; body: Record<string, unknown>; jsep?: unknown }[] = [];

  async open(): Promise<number> {
    this.opened += 1;
    return 1;
  }

  async attach(plugin: string): Promise<number> {
    this.attachedPlugins.push(plugin);
    return 7;
  }

  send(handleId: number, body: Record<string, unknown>, jsep?: unknown): Promise<{ data: unknown; jsep: null }> {
    this.sends.push({ handleId, body, jsep });
    return Promise.resolve({ data: {}, jsep: null });
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  ontrack: ((event: { track: EventTarget }) => void) | null = null;
  onicecandidate: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  iceGatheringState = "complete";
  connectionState = "new";
  remoteDescriptions: unknown[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  closed = false;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: "answer", sdp: "v=0 answer" };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
  }

  close(): void {
    this.closed = true;
  }
}

function makeViewer(overrides: {
  pin?: string | null;
  onTrack?: (track: EventTarget) => void;
  onGone?: () => void;
} = {}): { viewer: PopoutViewer; janus: FakeJanus } {
  const janus = new FakeJanus();
  const viewer = new PopoutViewer({
    room: { janusUrl: "http://janus.local:8088/janus", roomId: 9, token: "tok", pin: overrides.pin !== undefined ? overrides.pin : "pin9" },
    feedId: 42,
    videoMid: "1",
    onTrack: overrides.onTrack ?? (() => undefined),
    onGone: overrides.onGone ?? (() => undefined),
    // The factory captures the REAL options PopoutViewer built — the test
    // drives the flow through them (onJsep/onSessionLost).
    janusFactory: (realOptions) => {
      janus.options = realOptions;
      return janus as unknown as JanusClient;
    },
    peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
  });
  return { viewer, janus };
}

describe("PopoutViewer", () => {
  it("joins the room as a VIDEO-ONLY subscriber (feed + mid, pin included)", async () => {
    const { viewer, janus } = makeViewer();
    await viewer.start();
    expect(janus.opened).toBe(1);
    expect(janus.attachedPlugins).toEqual(["janus.plugin.videoroom"]);
    expect(janus.sends[0]!.handleId).toBe(7);
    expect(janus.sends[0]!.body).toMatchObject({
      request: "join",
      ptype: "subscriber",
      room: 9,
      streams: [{ feed: 42, mid: "1" }],
      autoupdate: false,
      pin: "pin9",
    });
  });

  it("answers Janus's offer and starts the stream", async () => {
    const { viewer, janus } = makeViewer({ pin: null });
    await viewer.start();
    janus.options.onJsep(7, { type: "offer", sdp: "v=0 offer" });
    await vi.waitFor(() => expect(janus.sends.some((entry) => entry.body.request === "start")).toBe(true));
    const pc = FakePeerConnection.instances.at(-1)!;
    expect(pc.remoteDescriptions).toEqual([{ type: "offer", sdp: "v=0 offer" }]);
    const start = janus.sends.find((entry) => entry.body.request === "start")!;
    expect(start.jsep).toEqual({ type: "answer", sdp: "v=0 answer" });
    // No pin in the join when the room has none.
    expect(janus.sends[0]!.body.pin).toBeUndefined();
  });

  it("hands the video track to the UI and reports the feed gone when it ends", async () => {
    const tracks: EventTarget[] = [];
    let gone = 0;
    const { viewer, janus } = makeViewer({ onTrack: (track) => tracks.push(track), onGone: () => { gone += 1; } });
    await viewer.start();
    janus.options.onJsep(7, { type: "offer", sdp: "v=0 offer" });
    await vi.waitFor(() => expect(FakePeerConnection.instances.length).toBeGreaterThan(0));
    const pc = FakePeerConnection.instances.at(-1)!;
    const track = new EventTarget();
    pc.ontrack!({ track });
    expect(tracks).toHaveLength(1);
    track.dispatchEvent(new Event("ended"));
    expect(gone).toBe(1);
  });

  it("dispose closes the transport and ignores late offers", async () => {
    const { viewer, janus } = makeViewer();
    await viewer.start();
    janus.options.onJsep(7, { type: "offer", sdp: "v=0 offer" });
    // Wait for the FULL first negotiation (start sent), not just the PC —
    // otherwise the snapshot below races the first legitimate start.
    await vi.waitFor(() => expect(janus.sends.some((entry) => entry.body.request === "start")).toBe(true));
    const pc = FakePeerConnection.instances.at(-1)!;
    viewer.dispose();
    expect(pc.closed).toBe(true);
    expect(janus.destroyed).toBe(1);
    // A late offer (or a session-lost during destroy) must not negotiate or fire onGone.
    const sendsBeforeLateOffer = janus.sends.length;
    janus.options.onJsep(7, { type: "offer", sdp: "late" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(janus.sends.slice(sendsBeforeLateOffer).some((entry) => entry.body.request === "start")).toBe(false);
  });
});
