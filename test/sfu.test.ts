import { describe, expect, it, vi, beforeEach } from "vitest";
import { SfuSession, type SfuCallbacks } from "../src/core/sfu";
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
    const configure = sends.find((entry) => entry.body.request === "configure");
    expect(configure?.body).toMatchObject({ audio: true, video: true });

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
});
