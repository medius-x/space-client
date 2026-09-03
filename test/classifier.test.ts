import { describe, expect, it } from "vitest";
import { classifyFeed, diffSubscriptions, SlotMidTranslator, wantedStreams } from "../src/core/classifier";
import type { FeedInfo, FeedStream } from "../src/types";

function stream(type: "audio" | "video", mid: string, mindex: number, disabled = false): FeedStream {
  return { type, mid, mindex, disabled };
}

/** The canonical wire shape of a sharing publisher: [mic audio, screen video, share audio]. */
function sharingFeed(): FeedInfo {
  return {
    feedId: 42,
    display: "alice",
    streams: [
      stream("audio", "0", 0),
      stream("video", "1", 1),
      stream("audio", "2", 2),
    ],
  };
}

describe("classifyFeed", () => {
  it("voice = lowest-mindex audio; further audio mids = share audio", () => {
    expect(classifyFeed(sharingFeed())).toEqual({
      voiceMid: "0",
      shareAudioMids: ["2"],
      videoMids: ["1"],
    });
  });

  it("a voice-only publisher has no share audio", () => {
    const feed: FeedInfo = { feedId: 1, display: "bob", streams: [stream("audio", "0", 0)] };
    expect(classifyFeed(feed)).toEqual({ voiceMid: "0", shareAudioMids: [], videoMids: [] });
  });

  it("a DISABLED lowest audio leaves the next audio as voice (mic muted-then-share edge)", () => {
    const feed: FeedInfo = {
      feedId: 1,
      display: "carol",
      streams: [stream("audio", "0", 0, true), stream("audio", "3", 3)],
    };
    expect(classifyFeed(feed).voiceMid).toBe("3");
  });
});

describe("wantedStreams", () => {
  it("voice always; video+share only for viewed feeds", () => {
    const feeds = [sharingFeed()];
    expect(wantedStreams(feeds, new Set())).toEqual([{ feed: 42, mid: "0" }]);
    expect(wantedStreams(feeds, new Set([42]))).toEqual([
      { feed: 42, mid: "0" },
      { feed: 42, mid: "1" },
      { feed: 42, mid: "2" },
    ]);
  });
});

describe("diffSubscriptions", () => {
  it("computes subscribe/unsubscribe deltas keyed by feed:mid", () => {
    const current = new Set(["42:0", "42:1", "42:2"]);
    const diff = diffSubscriptions(current, [{ feed: 42, mid: "0" }, { feed: 7, mid: "0" }]);
    expect(diff.subscribe).toEqual([{ feed: 7, mid: "0" }]);
    expect(diff.unsubscribe).toEqual([{ feed: 42, mid: "1" }, { feed: 42, mid: "2" }]);
  });
});

describe("SlotMidTranslator", () => {
  it("translates slot mids to stream mids and forgets whole feeds", () => {
    const translator = new SlotMidTranslator();
    // The live bug from the Java client: slot mid 1 carried feed_mid 2 and vice versa.
    translator.onAttached("1", 42, "2");
    translator.onAttached("2", 42, "1");
    expect(translator.resolve("1")).toEqual({ feedId: 42, streamMid: "2" });
    expect(translator.resolve("2")).toEqual({ feedId: 42, streamMid: "1" });
    expect(translator.resolve("9")).toBeUndefined();

    translator.forgetFeed(42);
    expect(translator.resolve("1")).toBeUndefined();
  });
});
