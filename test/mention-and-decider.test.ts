import { describe, expect, it } from "vitest";
import { segmentMessageContent } from "../src/domain/logic/mention-segmenter";
import { decideNotification, messageMentionsUser } from "../src/domain/logic/notification-decider";
import { buildReplyPreview } from "../src/domain/logic/reply-tree";

describe("segmentMessageContent", () => {
  it("splits text and mention spans by the server's offsets", () => {
    const content = "hey @alice and @everyone!";
    const segments = segmentMessageContent(content, [
      { type: "USER", id: 1, name: "alice", start: 4, end: 10 },
      { type: "EVERYONE", id: null, name: "@everyone", start: 15, end: 24 },
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "mention", "text", "mention", "text"]);
    expect(segments[1]).toMatchObject({ kind: "mention", text: "@alice" });
    expect(segments[3]).toMatchObject({ kind: "mention", text: "@everyone" });
  });

  it("tolerates malformed and overlapping ranges", () => {
    const segments = segmentMessageContent("@a @b", [
      { type: "USER", id: 1, name: "a", start: 0, end: 2 },
      { type: "USER", id: 2, name: "b", start: 1, end: 6 }, // overlaps → dropped
      { type: "USER", id: 3, name: "ghost", start: -5, end: 2 }, // malformed → dropped
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "mention", text: "@a" });
    expect(segments[1]).toMatchObject({ kind: "text", text: " @b" });
  });

  it("empty mentions degrade to a single text segment", () => {
    expect(segmentMessageContent("plain", [])).toEqual([{ kind: "text", text: "plain" }]);
  });

  it("NULL content (attachment-only messages) does not crash", () => {
    expect(segmentMessageContent(null, [])).toEqual([]);
    expect(segmentMessageContent(null, [{ type: "USER", id: 1, name: "a", start: 0, end: 2 }])).toEqual([]);
    expect(buildReplyPreview(null)).toBe("");
  });
});

describe("decideNotification", () => {
  it("nothing while watching the receiving channel in a focused window", () => {
    expect(decideNotification({ mention: true, windowFocused: true, inOpenChannel: true })).toBe("none");
    expect(decideNotification({ mention: false, windowFocused: true, inOpenChannel: true })).toBe("none");
  });

  it("mentions always ping (with sound); non-mentions toast only unfocused", () => {
    expect(decideNotification({ mention: true, windowFocused: false, inOpenChannel: false })).toBe("toast-sound");
    expect(decideNotification({ mention: true, windowFocused: true, inOpenChannel: false })).toBe("toast-sound");
    expect(decideNotification({ mention: false, windowFocused: false, inOpenChannel: false })).toBe("toast");
    expect(decideNotification({ mention: false, windowFocused: true, inOpenChannel: false })).toBe("none");
  });

  it("mention detection covers USER-by-name plus EVERYONE/HERE", () => {
    expect(messageMentionsUser([{ type: "USER", name: "alice" }], "alice")).toBe(true);
    expect(messageMentionsUser([{ type: "USER", name: "alice" }], "bob")).toBe(false);
    expect(messageMentionsUser([{ type: "EVERYONE", name: "@everyone" }], "bob")).toBe(true);
    expect(messageMentionsUser([{ type: "HERE", name: "@here" }], "bob")).toBe(true);
    expect(messageMentionsUser([{ type: "ROLE", name: "admin" }], "bob")).toBe(false); // roles are M7
  });
});
