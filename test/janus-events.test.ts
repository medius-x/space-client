import { describe, expect, it } from "vitest";
import { isBadPin, isRoomVanished, parseVideoroomData } from "../src/core/janus-events";

describe("parseVideoroomData", () => {
  it("parses joined with the publishers list and their streams", () => {
    const event = parseVideoroomData({
      videoroom: "joined",
      publishers: [
        { id: 11, display: "alice", streams: [
          { type: "audio", mid: "0", mindex: 0 },
          { type: "video", mid: "1", mindex: 1 },
        ] },
      ],
    });
    expect(event).toEqual({
      kind: "joined",
      publishers: [
        {
          feedId: 11,
          display: "alice",
          streams: [
            { type: "audio", mid: "0", mindex: 0, disabled: false },
            { type: "video", mid: "1", mindex: 1, disabled: false },
          ],
        },
      ],
    });
  });

  it("parses event carrying unpublished / leaving", () => {
    expect(parseVideoroomData({ videoroom: "event", unpublished: 11 })).toEqual({
      kind: "event",
      publishers: undefined,
      unpublished: 11,
      leaving: undefined,
    });
    expect(parseVideoroomData({ videoroom: "event", leaving: 12 })).toEqual({
      kind: "event",
      publishers: undefined,
      unpublished: undefined,
      leaving: 12,
    });
  });

  it("parses attached carrying BOTH mid spaces (slot vs feed stream)", () => {
    const event = parseVideoroomData({
      videoroom: "attached",
      streams: [{ type: "audio", mid: "1", feed_id: 42, feed_mid: "2" }],
    });
    expect(event).toEqual({
      kind: "attached",
      streams: [{ slotMid: "1", feedId: 42, streamMid: "2" }],
    });
  });

  it("parses errors with codes (426 vanished / 433 bad pin)", () => {
    expect(isRoomVanished(parseVideoroomData({ error_code: 426, error: "No such room" })!)).toBe(true);
    expect(isBadPin(parseVideoroomData({ error_code: 433, error: "Unauthorized" })!)).toBe(true);
    expect(isRoomVanished(parseVideoroomData({ videoroom: "updating" })!)).toBe(false);
  });

  it("returns null for unconsumed shapes", () => {
    expect(parseVideoroomData(null)).toBeNull();
    expect(parseVideoroomData({ videoroom: "event" })).toBeNull(); // no consumed keys
    expect(parseVideoroomData({ videoroom: "attached", streams: [] })).toBeNull();
    expect(parseVideoroomData({ videoroom: "somethingelse" })).toBeNull();
  });

  it("marks disabled streams (a stopped share announces itself as disabled)", () => {
    const event = parseVideoroomData({
      videoroom: "event",
      publishers: [{ id: 1, display: "bob", streams: [{ type: "video", mid: "3", mindex: 3, disabled: true }] }],
    });
    expect(event?.kind).toBe("event");
    if (event?.kind === "event") {
      expect(event.publishers?.[0]?.streams[0]?.disabled).toBe(true);
    }
  });
});
