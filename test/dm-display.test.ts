import { describe, expect, it } from "vitest";
import { dmDisplayName, dmPreviewText, shouldRefreshPreview } from "../src/domain/logic/dm-display";
import type { DmChannel, UserSummary } from "../src/types";

function user(id: number, username: string): UserSummary {
  return { id, username, avatarKey: null, avatarUrl: null, displayName: username };
}

function dm(overrides: Partial<DmChannel>): DmChannel {
  return {
    id: 1,
    type: "DM",
    name: "",
    ownerId: null,
    participants: [user(1, "alice"), user(2, "bob")],
    lastMessageId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageAuthorName: null,
    ...overrides,
  };
}

describe("dmDisplayName", () => {
  it("1:1 shows the OTHER participant, not me", () => {
    expect(dmDisplayName(dm({}), "alice")).toBe("bob");
    expect(dmDisplayName(dm({}), "bob")).toBe("alice");
  });

  it("1:1 with an empty roster degrades gracefully", () => {
    expect(dmDisplayName(dm({ participants: [] }), "alice")).toBe("Direct Message");
  });

  it("group prefers the stored name, then the participant list without me", () => {
    const group = dm({
      type: "GROUP_DM",
      ownerId: 1,
      participants: [user(1, "alice"), user(2, "bob"), user(3, "carol")],
    });
    expect(dmDisplayName({ ...group, name: "devs" }, "alice")).toBe("devs");
    expect(dmDisplayName({ ...group, name: "  " }, "alice")).toBe("bob, carol");
    expect(dmDisplayName({ ...group, name: "", participants: [user(1, "alice")] }, "alice")).toBe("Group");
  });
});

describe("dmPreviewText", () => {
  it("no message yet / blank content", () => {
    expect(dmPreviewText(dm({}))).toBe("No messages yet");
    expect(dmPreviewText(dm({ lastMessagePreview: "   " }))).toBe("No messages yet");
  });

  it("author prefix appears only when the author is known; long text clamps to 40 chars", () => {
    expect(dmPreviewText(dm({ lastMessagePreview: "hi there" }))).toBe("hi there");
    expect(dmPreviewText(dm({ lastMessagePreview: "hi there", lastMessageAuthorName: "bob" }))).toBe("bob: hi there");
    const clamped = dmPreviewText(dm({ lastMessagePreview: "x".repeat(60), lastMessageAuthorName: "bob" }));
    expect(clamped.length).toBe(41); // 40 + ellipsis
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("collapses whitespace before clamping", () => {
    expect(dmPreviewText(dm({ lastMessagePreview: "a\n\n  b\tc" }))).toBe("a b c");
  });
});

describe("shouldRefreshPreview (edit guard)", () => {
  it("refreshes when there was no message yet or the message is at/after the last one", () => {
    expect(shouldRefreshPreview(dm({ lastMessageId: null }), 5)).toBe(true);
    expect(shouldRefreshPreview(dm({ lastMessageId: 10 }), 10)).toBe(true);
    expect(shouldRefreshPreview(dm({ lastMessageId: 10 }), 11)).toBe(true);
    // An EDIT of an older message must not drag the row to the top.
    expect(shouldRefreshPreview(dm({ lastMessageId: 10 }), 9)).toBe(false);
  });
});
