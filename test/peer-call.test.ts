import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PeerCallSession } from "../src/core/peer-call";
import type { CallSignal, IncomingCallSignal } from "../src/types";
import { FakePeerConnection, fakeTrack, resetFakePeerConnections } from "./mocks/fake-peer-connection";
import { installFakeMediaStream } from "./mocks/fake-media-stream";
import { planIceRestart, iceRestartDelayMs, ICE_RESTART_LADDER_MS } from "../src/domain/logic/ice-restart";
import { ringbackCycleSeconds, CHIME_PARTIALS_HZ } from "../src/domain/logic/call-sounds";

installFakeMediaStream();

function makeSession(overrides?: { isCaller?: boolean }): {
  session: PeerCallSession;
  signals: CallSignal[];
  events: { kind: string; on?: boolean }[];
  health: boolean[];
} {
  const signals: CallSignal[] = [];
  const events: { kind: string; on?: boolean }[] = [];
  const health: boolean[] = [];
  const session = new PeerCallSession({
    isCaller: overrides?.isCaller ?? true,
    peerUsername: "bob",
    iceServers: [],
    micStream: new MediaStream([fakeTrack("audio-mic")] as unknown as MediaStreamTrack[]),
    peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    sendSignal: (signal) => signals.push(signal),
    callbacks: {
      onRemoteTrack: (kind) => events.push({ kind }),
      onRemoteTrackEnded: (kind) => events.push({ kind: `${kind}-ended` }),
      onPeerMic: (on) => events.push({ kind: "peerMic", on }),
      onPeerDeafened: (on) => events.push({ kind: "peerDeafened", on }),
      onPeerCamera: (on) => events.push({ kind: "peerCamera", on }),
      onPeerScreen: (on) => events.push({ kind: "peerScreen", on }),
      onConnectionHealth: (healthy) => health.push(healthy),
      onNegotiated: () => events.push({ kind: "negotiated" }),
      onError: (message) => events.push({ kind: "error", on: undefined, ...(message ? {} : {}) } as { kind: string }),
    },
  });
  return { session, signals, events, health };
}

describe("PeerCallSession", () => {
  beforeEach(() => {
    resetFakePeerConnections();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pre-negotiates the 3-slot m-line contract: voice track + empty video/share slots", async () => {
    const { session } = makeSession();
    await session.startOffer();
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.transceivers).toHaveLength(3);
    expect(pc.transceivers.map((entry) => entry.kind)).toEqual(["audio", "video", "audio"]);
    expect(pc.transceivers[0]!.sender.track).toMatchObject({ id: "audio-mic" }); // live from the start
    expect(pc.transceivers[1]!.sender.track).toBeNull(); // camera slot — empty
    expect(pc.transceivers[2]!.sender.track).toBeNull(); // share-audio slot — empty
  });

  it("camera and share switches ride replaceTrack — offer count NEVER grows mid-call", async () => {
    const { session, signals } = makeSession();
    await session.startOffer();
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.offerCount).toBe(1);

    await session.setCameraStream(new MediaStream([fakeTrack("video-cam")] as unknown as MediaStreamTrack[]));
    expect(signals.some((signal) => signal.type === "CAM_ON")).toBe(true);
    expect(pc.transceivers[1]!.sender.track).toMatchObject({ id: "video-cam" });

    await session.setCameraStream(null);
    expect(signals.some((signal) => signal.type === "CAM_OFF")).toBe(true);

    await session.startShare(new MediaStream([
      fakeTrack("video-screen") as unknown as MediaStreamTrack,
      fakeTrack("audio-share") as unknown as MediaStreamTrack,
    ]));
    expect(signals.some((signal) => signal.type === "SCREEN_ON")).toBe(true);
    expect(pc.transceivers[1]!.sender.track).toMatchObject({ id: "video-screen" });
    expect(pc.transceivers[2]!.sender.track).toMatchObject({ id: "audio-share" }); // the SECOND audio slot

    await session.stopShare();
    expect(pc.transceivers[1]!.sender.track).toBeNull();
    expect(pc.transceivers[2]!.sender.track).toBeNull();
    expect(pc.offerCount).toBe(1); // still the one initial offer — zero renegotiation
  });

  it("mic toggle flips the track and signals the peer", async () => {
    const { session, signals } = makeSession();
    await session.startOffer();
    const pc = FakePeerConnection.instances[0]!;
    session.setMicEnabled(false);
    expect(pc.transceivers[0]!.sender.track).toMatchObject({ enabled: false });
    expect(signals.some((signal) => signal.type === "MIC_OFF")).toBe(true);
    session.setMicEnabled(true);
    expect(signals.some((signal) => signal.type === "MIC_ON")).toBe(true);
  });

  it("callee answers an offer in place and drains ICE buffered before the answer", async () => {
    const { session, signals } = makeSession({ isCaller: false });
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.remoteDescription).toBeNull();

    // ICE arrives BEFORE the offer — must be buffered, not dropped.
    await session.handleSignal({ type: "ICE", from: "bob", to: "me", sdp: null, candidate: { sdp: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(pc.iceCandidates).toHaveLength(0);

    await session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: "v=0 offer", candidate: null });
    expect(signals.some((signal) => signal.type === "ANSWER")).toBe(true);
    expect(pc.iceCandidates).toHaveLength(1); // drained once the remote description existed
  });

  it("caller: ICE failure schedules a restart offer on the ladder; callee just waits", async () => {
    const { session, signals } = makeSession({ isCaller: true });
    await session.startOffer();
    const pc = FakePeerConnection.instances[0]!;
    const offersBefore = pc.offerCount;

    pc.driveConnectionState("failed");
    vi.advanceTimersByTime(ICE_RESTART_LADDER_MS[0]! + 10);
    expect(pc.offerCount).toBe(offersBefore + 1); // restart offer after 1 s

    pc.driveConnectionState("failed"); // climb to the next rung
    vi.advanceTimersByTime(ICE_RESTART_LADDER_MS[1]! + 10);
    expect(pc.offerCount).toBe(offersBefore + 2);

    const callee = makeSession({ isCaller: false });
    const calleePc = FakePeerConnection.instances[1]!;
    await callee.session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: "v=0", candidate: null });
    calleePc.driveConnectionState("failed");
    vi.advanceTimersByTime(60_000);
    expect(calleePc.offerCount).toBe(0); // the callee NEVER restarts (no glare)
    expect(signals.length).toBeGreaterThan(0);
  });

  it("routes the voice slot through ontrack; video/share slots are bound PASSIVELY", async () => {
    const { session, events } = makeSession();
    await session.startOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.driveOnTrackOn(pc.transceivers[0]!, fakeTrack("audio-voice"));
    expect(events.map((entry) => entry.kind)).toEqual(["voice"]);
    // The EMPTY slots never fire ontrack when the peer activates them via replaceTrack
    // (no msid enters the SDP) — an ontrack for them must NOT be the binding path.
    pc.driveOnTrackOn(pc.transceivers[1]!, fakeTrack("video-peer"));
    pc.driveOnTrackOn(pc.transceivers[2]!, fakeTrack("audio-share"));
    expect(events).toHaveLength(1);
  });

  it("passively binds the receiver tracks of the empty slots after each remote description", async () => {
    const offerSdp = "v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:0\r\nm=video 9 RTP/SAVPF 96\r\na=mid:1\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:2\r\n";
    const { session, events } = makeSession({ isCaller: false });
    await session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: offerSdp, candidate: null });
    const kinds = events.map((entry) => entry.kind);
    expect(kinds).toContain("video");  // receiver.track of the video slot — muted until RTP
    expect(kinds).toContain("share");  // receiver.track of the second audio slot

    // Caller side: the passive bind runs after the ANSWER lands too.
    const caller = makeSession({ isCaller: true });
    await caller.session.startOffer();
    await caller.session.handleSignal({ type: "ANSWER", from: "bob", to: "me", sdp: "v=0 answer", candidate: null });
    const callerKinds = caller.events.map((entry) => entry.kind);
    expect(callerKinds).toContain("video");
    expect(callerKinds).toContain("share");

    // Re-running (an ICE restart round) must not double-bind the same tracks.
    await session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: "v=0 offer2", candidate: null });
    expect(events.filter((entry) => entry.kind === "video")).toHaveLength(1);
  });

  it("callee adopts the media slots from the offer — no dead pre-created transceivers (live 2026-10-08)", async () => {
    // The callee used to pre-create empty video/share transceivers; Chromium
    // does not reuse them on SRD, so its senders sat on dead unassociated
    // slots and its share RTP never reached the caller (black tile).
    const offerSdp = "v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:0\r\nm=video 9 RTP/SAVPF 96\r\na=mid:1\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:2\r\n";
    const { session } = makeSession({ isCaller: false });
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.transceivers).toHaveLength(1); // only the mic before the offer

    await session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: offerSdp, candidate: null });
    // The SRD created recvonly transceivers for the offer's m-lines; the answer
    // path must raise ours to sendrecv or the callee could never send.
    expect(pc.transceivers.map((entry) => entry.direction)).toEqual(["sendrecv", "sendrecv", "sendrecv"]);

    await session.startShare(new MediaStream([
      fakeTrack("video-screen") as unknown as MediaStreamTrack,
      fakeTrack("audio-share") as unknown as MediaStreamTrack,
    ]));
    expect(pc.transceivers[1]!.sender.track).toMatchObject({ id: "video-screen" }); // video slot by mid
    expect(pc.transceivers[2]!.sender.track).toMatchObject({ id: "audio-share" }); // share slot by mid
  });

  it("senders and receivers resolve by a=mid from the negotiated SDP, not by array index", async () => {
    // Exotic mids on purpose: video="7", share="3" — an array-index contract would
    // pick the wrong transceivers after Chromium's own SRD matching shuffled them.
    const offerSdp = "v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:0\r\nm=video 9 RTP/SAVPF 96\r\na=mid:7\r\nm=audio 9 RTP/SAVPF 111\r\na=mid:3\r\n";
    const { session } = makeSession({ isCaller: false });
    await session.handleSignal({ type: "OFFER", from: "bob", to: "me", sdp: offerSdp, candidate: null });
    const pc = FakePeerConnection.instances[0]!;
    // Simulate SRD assigning those mids to OUR transceivers (any order works).
    pc.transceivers[1]!.mid = "7";
    pc.transceivers[2]!.mid = "3";

    await session.setCameraStream(new MediaStream([fakeTrack("video-cam")] as unknown as MediaStreamTrack[]));
    expect(pc.transceivers[1]!.sender.track).toMatchObject({ id: "video-cam" }); // video slot by mid 7

    await session.startShare(new MediaStream([
      fakeTrack("video-screen") as unknown as MediaStreamTrack,
      fakeTrack("audio-share") as unknown as MediaStreamTrack,
    ]));
    expect(pc.transceivers[2]!.sender.track).toMatchObject({ id: "audio-share" }); // share slot by mid 3
  });

  it("deafen gates nothing locally in the session but signals DEAFEN to the peer", async () => {
    const { session, signals } = makeSession();
    session.setDeafened(true);
    expect(signals.some((signal) => signal.type === "DEAFEN_ON")).toBe(true);
    session.setDeafened(false);
    expect(signals.some((signal) => signal.type === "DEAFEN_OFF")).toBe(true);

    const { session: receiverSession, events } = makeSession({ isCaller: false });
    await receiverSession.handleSignal({ type: "DEAFEN_ON", from: "bob", to: "me", sdp: null, candidate: null });
    expect(events.some((entry) => entry.kind === "peerDeafened" && entry.on === true)).toBe(true);
  });
});

describe("ice-restart policy (pure)", () => {
  it("only the caller schedules; the callee waits; connections reset the ladder", () => {
    expect(planIceRestart(true, "failed")).toBe("schedule-restart");
    expect(planIceRestart(false, "failed")).toBe("await-caller-restart");
    expect(planIceRestart(true, "connected")).toBe("reset-backoff");
    expect(planIceRestart(false, "connected")).toBe("reset-backoff");
    expect(planIceRestart(true, "disconnected")).toBe("none");
    expect(planIceRestart(false, "new")).toBe("none");
  });

  it("the ladder is 1→2→4→8→16 s, capped", () => {
    expect([1, 2, 3, 4, 5, 9].map(iceRestartDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000]);
  });
});

describe("call sounds (pure schedules)", () => {
  it("ringback cadence is a 3 s loop (1.8 s burst + 1.2 s pause)", () => {
    expect(ringbackCycleSeconds()).toBe(3);
  });

  it("the chime is a bell — three partials, not a beep", () => {
    expect(CHIME_PARTIALS_HZ).toHaveLength(3);
    expect(new Set(CHIME_PARTIALS_HZ).size).toBe(3);
  });
});
