import { describe, expect, it } from "vitest";
import {
  extractAudioFmtpLines,
  mungeStereoIntoAnswerIfOfferHasIt,
  mungeStereoIntoOffer,
} from "../src/core/sdp";

const NL = "\r\n";

function offerSdp(shareTrackId: string, withStereoAlready = false): string {
  const shareFmtp = withStereoAlready
    ? `a=fmtp:111 minptime=10;useinbandfec=1;stereo=1`
    : `a=fmtp:111 minptime=10;useinbandfec=1`;
  return [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    `m=audio 9 UDP/TLS/RTP/SAVPF 111`,
    "a=mid:0",
    "a=msid:stream0 track-mic",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    `m=video 9 UDP/TLS/RTP/SAVPF 96`,
    "a=mid:1",
    `a=msid:stream0 track-screen`,
    "a=rtpmap:96 VP8/90000",
    `m=audio 9 UDP/TLS/RTP/SAVPF 111`,
    "a=mid:2",
    `a=msid:stream0 ${shareTrackId}`,
    "a=rtpmap:111 opus/48000/2",
    shareFmtp,
  ].join(NL) + NL;
}

describe("mungeStereoIntoOffer", () => {
  it("adds stereo=1 to the share-audio m-line found by msid track id", () => {
    const munged = mungeStereoIntoOffer(offerSdp("track-share"), "track-share");
    const lines = extractAudioFmtpLines(munged);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.fmtp).toBe("minptime=10;useinbandfec=1"); // mic untouched
    expect(lines[1]?.fmtp).toBe("minptime=10;useinbandfec=1;stereo=1");
  });

  it("is idempotent when stereo=1 is already present", () => {
    const once = mungeStereoIntoOffer(offerSdp("track-share", true), "track-share");
    const twice = mungeStereoIntoOffer(once, "track-share");
    expect(twice).toBe(once);
  });

  it("falls back to the LAST m=audio section when the msid does not match", () => {
    const munged = mungeStereoIntoOffer(offerSdp("track-share"), "track-nonexistent");
    const lines = extractAudioFmtpLines(munged);
    expect(lines[1]?.fmtp).toContain("stereo=1");
    expect(lines[0]?.fmtp).not.toContain("stereo=1");
  });

  it("leaves the SDP untouched when there is no audio section at all", () => {
    const videoOnly = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n";
    expect(mungeStereoIntoOffer(videoOnly, "x")).toBe(videoOnly);
  });

  it("inserts an fmtp line when the section had none", () => {
    const noFmtp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      `a=msid:stream0 track-share`,
      "a=rtpmap:111 opus/48000/2",
    ].join(NL) + NL;
    const munged = mungeStereoIntoOffer(noFmtp, "track-share");
    expect(munged).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1");
  });
});

describe("mungeStereoIntoAnswerIfOfferHasIt", () => {
  it("keeps stereo=1 in the answer only where the offer had it", () => {
    const offer = offerSdp("track-share", true);
    const answer = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:1",
      "a=rtpmap:96 VP8/90000",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:2",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=1",
    ].join(NL) + NL;

    const munged = mungeStereoIntoAnswerIfOfferHasIt(answer, offer);
    const lines = extractAudioFmtpLines(munged);
    expect(lines[0]?.fmtp).not.toContain("stereo=1");
    expect(lines[1]?.fmtp).toContain("stereo=1");
  });

  it("does nothing when the offer has no stereo anywhere", () => {
    const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n";
    expect(mungeStereoIntoAnswerIfOfferHasIt(answer, offerSdp("track-share"))).toBe(answer);
  });
});
