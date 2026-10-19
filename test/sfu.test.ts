import { describe, expect, it, vi, beforeEach } from "vitest";
import { SfuSession, SubscriberTransportError, type SfuCallbacks } from "../src/core/sfu";
import type { JanusClient } from "../src/core/janus";
import type { FeedInfo } from "../src/types";
import { FakePeerConnection, fakeTrack, resetFakePeerConnections } from "./mocks/fake-peer-connection";
import { installFakeMediaStream } from "./mocks/fake-media-stream";

installFakeMediaStream();

/**
 * The three contract tests that guard the wire invariants the Java client died on:
 * deferred subscriber join, publisher-offer serialization, onnegotiationneeded no-op.
 */

function makeJanus(): {
  janus: JanusClient;
  sends: { handleId: number; body: Record<string, unknown> }[];
  attaches: string[];
} {
  const sends: { handleId: number; body: Record<string, unknown> }[] = [];
  const attaches: string[] = [];
  const janus = {
    attach: async (plugin: string) => {
      attaches.push(plugin);
      return 55 + attaches.length;
    },
    send: async (handleId: number, body: Record<string, unknown>) => {
      sends.push({ handleId, body });
      return { data: { videoroom: "ok" }, jsep: null };
    },
  } as unknown as JanusClient;
  return { janus, sends, attaches };
}

function makeCallbacks(): {
  callbacks: SfuCallbacks;
  participants: FeedInfo[][];
  tracks: { username: string; kind: string }[];
  ended: { username: string; kind: string }[];
  errors: Error[];
} {
  const participants: FeedInfo[][] = [];
  const tracks: { username: string; kind: string }[] = [];
  const ended: { username: string; kind: string }[] = [];
  const errors: Error[] = [];
  return {
    participants,
    tracks,
    ended,
    errors,
    callbacks: {
      onParticipants: (feeds) => participants.push(feeds),
      onRemoteTrack: (_feedId, username, kind) => tracks.push({ username, kind }),
      onRemoteTrackEnded: (_feedId, username, kind) => ended.push({ username, kind }),
      onState: () => undefined,
      onError: (error) => errors.push(error),
    },
  };
}

function mediaSourceWithMic() {
  return {
    getUserMedia: async () => new MediaStream([fakeTrack("audio-mic")] as unknown as MediaStreamTrack[]),
  };
}

describe("SfuSession", () => {
  beforeEach(() => {
    resetFakePeerConnections();
  });

  it("defers the subscriber join until a wanted stream exists — never joins empty", async () => {
    const { janus, sends, attaches } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });

    // A publisher event with NO streams must not produce a subscriber join.
    session.handleEvent({ kind: "joined", publishers: [] });
    session.handleEvent({ kind: "event", publishers: [{ feedId: 9, display: "bob", streams: [] }] });
    expect(attaches).toHaveLength(0);

    // One voice stream → subscriber handle attached and join sent with that stream.
    session.handleEvent({
      kind: "event",
      publishers: [{ feedId: 9, display: "bob", streams: [{ type: "audio", mid: "0", mindex: 0 }] }],
    });
    await vi.waitFor(() => expect(sends.some((entry) => entry.body.request === "join" && entry.body.ptype === "subscriber")).toBe(true));
    const join = sends.find((entry) => entry.body.request === "join" && entry.body.ptype === "subscriber");
    expect(join?.body.streams).toEqual([{ feed: 9, mid: "0" }]);
    expect(join?.body.autoupdate).toBe(false);
  });

  it("publisher join + configure offer flow; onnegotiationneeded stays a no-op", async () => {
    const { janus, sends } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: "p" },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });

    await session.start();

    const publisherJoin = sends.find((entry) => entry.body.ptype === "publisher");
    expect(publisherJoin?.body).toMatchObject({ request: "join", room: 5, display: "alice", pin: "p" });
    // The REMB ceiling rides both the join and every configure — without it
    // Janus caps the publisher at the room's 1 Mbps default and every preset
    // above that is silently crushed (the choppy-viewer live report).
    expect(publisherJoin?.body.bitrate).toBe(20_000_000);
    const configure = sends.find((entry) => entry.body.request === "configure");
    expect(configure?.body).toMatchObject({ audio: true, video: true, bitrate: 20_000_000 });

    const publisher = FakePeerConnection.instances[0]!;
    // addTrack fired onnegotiationneeded internally — no extra offers may result from it.
    expect(publisher.offerCount).toBe(1);
  });

  it("serializes concurrent share start/stop into sequential offers (busy-guard)", async () => {
    const { janus } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });
    await session.start();
    const publisher = FakePeerConnection.instances[0]!;
    expect(publisher.offerCount).toBe(1);

    // Hold gathering so the first renegotiation is in flight while the second arrives.
    publisher.gatheringHold = true;
    const displayStream = new MediaStream();
    void session.startShare(displayStream).catch(() => undefined);
    await session.stopShare().catch(() => undefined);
    publisher.completeGathering();
    await vi.waitFor(() => expect(publisher.offerCount).toBeGreaterThanOrEqual(2));

    // No overlap is directly observable here, but the count must be bounded: exactly the
    // initial offer + the queued re-run (start+stop coalesce into one renegotiation).
    await vi.waitFor(() => expect(publisher.offerCount).toBe(2));
  });

  it("routes a track by slot-mid translation and fires teardown on unpublished", async () => {
    const { janus, sends } = makeJanus();
    const sink = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks: sink.callbacks,
    });
    await session.start();

    session.handleEvent({
      kind: "event",
      publishers: [{ feedId: 9, display: "bob", streams: [{ type: "audio", mid: "0", mindex: 0 }] }],
    });
    await vi.waitFor(() => expect(sends.some((entry) => entry.body.request === "join" && entry.body.ptype === "subscriber")).toBe(true));

    // Slot mid 3 carries stream mid 0 (the two mid spaces differ) — voice of bob.
    session.handleEvent({ kind: "attached", streams: [{ slotMid: "3", feedId: 9, streamMid: "0" }] });
    const subscriber = FakePeerConnection.instances[1]!;
    subscriber.driveOnTrack("3", fakeTrack("audio-bob"));
    expect(sink.tracks).toEqual([{ username: "bob", kind: "voice" }]);

    // Feed leaves → voice teardown fires.
    session.handleEvent({ kind: "event", unpublished: 9 });
    expect(sink.ended).toEqual([{ username: "bob", kind: "voice" }]);
  });

  it("re-delivers the returning publisher's voice WITHOUT ontrack (recycled m-line)", async () => {
    // Live bug 2026-10-05: a banned-then-unbanned member re-joined and was inaudible to
    // everyone sitting in the room — Janus recycled the subscriber m-line, Chromium
    // returned the SAME receiver track without firing ontrack, and the listener's voice
    // chain (detached when the old feed died) was never re-attached.
    const { janus, sends } = makeJanus();
    const sink = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks: sink.callbacks,
    });
    await session.start();

    // Bob joins (feed 9), his voice flows through the regular ontrack path on slot 3.
    session.handleEvent({
      kind: "event",
      publishers: [{ feedId: 9, display: "bob", streams: [{ type: "audio", mid: "0", mindex: 0 }] }],
    });
    await vi.waitFor(() => expect(sends.some((entry) => entry.body.request === "join" && entry.body.ptype === "subscriber")).toBe(true));
    const subscriber = FakePeerConnection.instances[1]!;
    const recycledTrack = fakeTrack("audio-bob");
    subscriber.seedRemoteTransceiver("3", recycledTrack);
    session.handleEvent({ kind: "attached", streams: [{ slotMid: "3", feedId: 9, streamMid: "0" }] });
    subscriber.driveOnTrackOn(subscriber.transceivers[subscriber.transceivers.length - 1]!, recycledTrack);
    expect(sink.tracks).toEqual([{ username: "bob", kind: "voice" }]);

    // Bob leaves (ban), then RETURNS with a NEW feed id on the SAME recycled slot.
    session.handleEvent({ kind: "event", unpublished: 9 });
    expect(sink.ended).toEqual([{ username: "bob", kind: "voice" }]);
    session.handleEvent({
      kind: "event",
      publishers: [{ feedId: 10, display: "bob", streams: [{ type: "audio", mid: "0", mindex: 0 }] }],
    });
    await vi.waitFor(() => expect(sends.some((entry) => entry.body.request === "subscribe")).toBe(true));
    // NO ontrack fires for the recycled m-line — only the gateway's offer arrives.
    session.handleEvent({ kind: "attached", streams: [{ slotMid: "3", feedId: 10, streamMid: "0" }] });
    await session.handleSubscriberOffer({ type: "offer", sdp: "v=0\nm=audio 3\n" });

    // The passive bind re-attached the SAME track object to the fresh feed's voice chain.
    expect(sink.tracks).toEqual([
      { username: "bob", kind: "voice" },
      { username: "bob", kind: "voice" },
    ]);

    // A repeated SRD of the same feed does NOT double-deliver (feedId:trackId dedup).
    await session.handleSubscriberOffer({ type: "offer", sdp: "v=0\nm=audio 3\n" });
    expect(sink.tracks).toHaveLength(2);
  });

  it("subscriber ICE failure surfaces as SubscriberTransportError (no silent death)", async () => {
    const { janus, sends } = makeJanus();
    const sink = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks: sink.callbacks,
    });
    await session.start();
    session.handleEvent({
      kind: "event",
      publishers: [{ feedId: 9, display: "bob", streams: [{ type: "audio", mid: "0", mindex: 0 }] }],
    });
    await vi.waitFor(() => expect(sends.some((entry) => entry.body.request === "join" && entry.body.ptype === "subscriber")).toBe(true));

    const subscriber = FakePeerConnection.instances[1]!;
    subscriber.driveConnectionState("connected"); // healthy rounds must stay silent
    expect(sink.errors).toHaveLength(0);

    subscriber.driveConnectionState("failed"); // incoming media dies — the signal fires ONCE
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toBeInstanceOf(SubscriberTransportError);

    await session.close();
    subscriber.driveConnectionState("failed"); // stale post-close callback — suppressed
    expect(sink.errors).toHaveLength(1);
  });

  it("camera publishes a video m-line and stopCamera tears the track down", async () => {
    const { janus } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });
    await session.start();
    const publisher = FakePeerConnection.instances[0]!;
    expect(publisher.offerCount).toBe(1);

    const cameraTrack = { ...fakeTrack("video-cam"), stop: vi.fn() };
    await session.startCamera(new MediaStream([cameraTrack as unknown as MediaStreamTrack]));
    expect(publisher.senders.map((sender) => (sender.track as { id: string }).id)).toContain("video-cam");
    expect(publisher.offerCount).toBe(2); // one renegotiation for the camera m-line
    expect(session.isCameraPublishing()).toBe(true);

    await session.stopCamera();
    expect(cameraTrack.stop).toHaveBeenCalled();
    expect(publisher.senders.map((sender) => (sender.track as { id: string }).id)).not.toContain("video-cam");
    expect(session.isCameraPublishing()).toBe(false);
    expect(session.getCameraTrack()).toBeNull();
  });

  it("camera and screen share are mutually exclusive (one outgoing video slot)", async () => {
    const { janus } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });
    await session.start();

    await session.startCamera(new MediaStream([fakeTrack("video-cam") as unknown as MediaStreamTrack]));
    const shareStream = new MediaStream([fakeTrack("video-screen") as unknown as MediaStreamTrack]);
    await expect(session.startShare(shareStream)).rejects.toThrow("camera is already publishing");

    await session.stopCamera();
    await session.startShare(shareStream); // camera off → the share takes the video slot
    await expect(session.startCamera(new MediaStream([fakeTrack("video-cam") as unknown as MediaStreamTrack])))
      .rejects.toThrow("screen share is already publishing");
  });

  it("compliance desired-states apply to live AND future tracks", async () => {
    const { janus } = makeJanus();
    const { callbacks } = makeCallbacks();
    const session = new SfuSession({
      room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
      username: "alice",
      janus,
      publisherHandleId: 42,
      mediaSource: mediaSourceWithMic(),
      peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      callbacks,
    });
    await session.start();

    // A moderator mute arrives BEFORE the share starts — the fresh track must comply.
    session.setShareAudioEnabled(false);
    const shareAudio = fakeTrack("audio-share");
    await session.startShare(new MediaStream([
      fakeTrack("video-screen") as unknown as MediaStreamTrack,
      shareAudio as unknown as MediaStreamTrack,
    ]));
    expect(shareAudio.enabled).toBe(false);
    expect(session.getMicTrack()!.enabled).toBe(true);

    // A self-mute gates the mic; a self-share-mute never exists (Discord semantics).
    session.setMicEnabled(false);
    expect(session.getMicTrack()!.enabled).toBe(false);
    session.setShareAudioEnabled(true);
    expect(shareAudio.enabled).toBe(true);
  });

  it("own-uplink watchdog: frozen RTP counters while unmuted fire onOwnUplinkStalled; growth stays silent", async () => {
    vi.useFakeTimers();
    try {
      const { janus } = makeJanus();
      const stalled: number[] = [];
      const session = new SfuSession({
        room: { janusUrl: "http://x", roomId: 5, token: null, pin: null },
        username: "alice",
        janus,
        publisherHandleId: 42,
        mediaSource: mediaSourceWithMic(),
        peerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
        callbacks: {
          ...makeCallbacks().callbacks,
          onOwnUplinkStalled: () => stalled.push(Date.now()),
        },
      });
      await session.start();

      const micSender = FakePeerConnection.instances[0]!.senders[0]!;
      let bytesSent = 10_000;
      micSender.getStats = () => Promise.resolve(new Map<string, unknown>([
        ["r", { type: "outbound-rtp", kind: "audio", bytesSent }],
      ]));

      // Growing counters (even in total silence an enabled track sends frames).
      for (let pollIndex = 0; pollIndex < 4; pollIndex += 1) {
        bytesSent += 480;
        await vi.advanceTimersByTimeAsync(5_100);
      }
      expect(stalled).toHaveLength(0);

      // Frozen counters: baseline, streak 1, streak 2 → the callback fires ONCE.
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(stalled).toHaveLength(1);

      // A muted track never trips the watchdog even with dead counters.
      session.setMicEnabled(false);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(stalled).toHaveLength(1);

      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
