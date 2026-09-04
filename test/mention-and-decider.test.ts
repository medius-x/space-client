import { describe, expect, it } from "vitest";
import { segmentMessageContent } from "../src/domain/logic/mention-segmenter";
import {
  decideNotification,
  messageHasEveryoneHere,
  messageMentionsUserDirect,
  type NotificationInput,
} from "../src/domain/logic/notification-decider";
import { buildReplyPreview } from "../src/domain/logic/reply-tree";

const BASE_PREFS = {
  everyoneHere: false,
  serverMode: "ALL",
  suppressEveryoneHere: false,
  notificationsEnabled: true,
  soundEnabled: true,
} as const;

function decide(overrides: Partial<NotificationInput>): string {
  return decideNotification({ ...BASE_PREFS, mention: false, windowFocused: false, inOpenChannel: false, ...overrides });
}

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
    expect(decide({ mention: true, windowFocused: true, inOpenChannel: true })).toBe("none");
    expect(decide({ mention: false, windowFocused: true, inOpenChannel: true })).toBe("none");
  });

  it("mentions always ping (with sound); non-mentions toast only unfocused", () => {
    expect(decide({ mention: true })).toBe("toast-sound");
    expect(decide({ mention: true, windowFocused: true, inOpenChannel: false })).toBe("toast-sound");
    expect(decide({ mention: false })).toBe("toast");
    expect(decide({ mention: false, windowFocused: true, inOpenChannel: false })).toBe("none");
  });

  it("the master switch kills everything", () => {
    expect(decide({ mention: true, notificationsEnabled: false })).toBe("none");
    expect(decide({ mention: false, notificationsEnabled: false })).toBe("none");
  });

  it("per-server mode: MENTIONS mutes non-mention toasts, NOTHING mutes all", () => {
    expect(decide({ mention: false, serverMode: "MENTIONS" })).toBe("none");
    expect(decide({ mention: true, serverMode: "MENTIONS" })).toBe("toast-sound");
    expect(decide({ mention: true, serverMode: "NOTHING" })).toBe("none");
  });

  it("soundEnabled off keeps the mention toast but drops the bell", () => {
    expect(decide({ mention: true, soundEnabled: false })).toBe("toast");
  });

  it("suppressEveryoneHere: @everyone stops counting as a mention (still toasts unfocused)", () => {
    expect(decide({ everyoneHere: true, suppressEveryoneHere: true })).toBe("toast"); // unfocused non-mention
    expect(decide({ everyoneHere: true, suppressEveryoneHere: true, windowFocused: true })).toBe("none");
    expect(decide({ everyoneHere: true, suppressEveryoneHere: false })).toBe("toast-sound");
    expect(decide({ everyoneHere: true, suppressEveryoneHere: true, serverMode: "MENTIONS" })).toBe("none");
  });

  it("direct vs broad mention detection", () => {
    expect(messageMentionsUserDirect([{ type: "USER", name: "alice" }], "alice")).toBe(true);
    expect(messageMentionsUserDirect([{ type: "USER", name: "alice" }], "bob")).toBe(false);
    expect(messageMentionsUserDirect([{ type: "EVERYONE", name: "@everyone" }], "bob")).toBe(false);
    expect(messageHasEveryoneHere([{ type: "EVERYONE", name: "@everyone" }])).toBe(true);
    expect(messageHasEveryoneHere([{ type: "HERE", name: "@here" }])).toBe(true);
    expect(messageHasEveryoneHere([{ type: "ROLE", name: "admin" }])).toBe(false);
  });
});
