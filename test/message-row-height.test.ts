import { describe, expect, it } from "vitest";
import {
  computeMosaicTiles,
  mosaicHeight,
  reservedVideoThumbBox,
  singleTileBox,
} from "../src/domain/logic/attachment-layout";
import { estimateRowHeight, QUOTE_DEPTH_MAX } from "../src/domain/logic/message-row-height";
import type { Attachment, ForwardInfo, Message, ReplyInfo } from "../src/types";

const NO_DIMS = (): null => null;

function inputs(overrides: Partial<Parameters<typeof estimateRowHeight>[1]> = {}) {
  return {
    startsGroup: true,
    hasDiscussionTile: false,
    jumboEmojiPx: 48,
    usableWidth: 700,
    knownDimsOf: NO_DIMS,
    ...overrides,
  };
}

function messageOf(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    channelId: 1,
    authorId: 1,
    authorUsername: "alice",
    content: null,
    createdAt: "2026-10-19T00:00:00Z",
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
    sticker: null,
    ...overrides,
  };
}

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    key: "img/a.png",
    fileName: "a.png",
    url: "https://example.com/img/a.png",
    thumbnailKey: null,
    thumbnailUrl: null,
    durationMillis: null,
    width: null,
    height: null,
    sizeBytes: null,
    ...overrides,
  };
}

/** The text part of a row so the attachment delta reads clean. */
function textOnlyHeight(content: string | null, usableWidth = 700): number {
  return estimateRowHeight(messageOf({ content }), inputs({ usableWidth }));
}

describe("estimateRowHeight — the estimate IS the first paint (render-math mirror)", () => {
  it("a single image with wire dims estimates EXACTLY its render box height", () => {
    const natural = { width: 4080, height: 3060 }; // the demo photo's shape
    const height = estimateRowHeight(
      messageOf({ attachments: [imageAttachment({ ...natural })] }),
      inputs({ usableWidth: 700 }),
    );
    expect(height - textOnlyHeight(null)).toBe(singleTileBox(700, natural.width, natural.height).height);
  });

  it("an unknown single image estimates the SAME square placeholder the first paint shows", () => {
    const height = estimateRowHeight(messageOf({ attachments: [imageAttachment()] }), inputs({ usableWidth: 700 }));
    // unknown dims → singleTileBox falls back to a usable-width square
    expect(height - textOnlyHeight(null)).toBe(singleTileBox(700, 0, 0).height);
  });

  it("a legacy image resolves through the injected learned-dims lookup", () => {
    const height = estimateRowHeight(
      messageOf({ attachments: [imageAttachment({ key: "legacy/old.jpg" })] }),
      inputs({ usableWidth: 700, knownDimsOf: (key) => key === "legacy/old.jpg" ? { width: 800, height: 600 } : null }),
    );
    expect(height - textOnlyHeight(null)).toBe(singleTileBox(700, 800, 600).height);
  });

  it("2-3 image rows estimate the render's tile side, not a flat 210", () => {
    for (const count of [2, 3]) {
      const attachments = Array.from({ length: count }, (_unused, index) => imageAttachment({ key: `img/${index}.png` }));
      const height = estimateRowHeight(messageOf({ attachments }), inputs({ usableWidth: 700 }));
      expect(height - textOnlyHeight(null)).toBe(mosaicHeight(computeMosaicTiles(count, 700)));
    }
    // concrete: at 700px two raw tiles would be (700-4)/2 = 348 tall — the old
    // flat estimate said 210 (the 138px gap bounced the scrollbar); the tile
    // cap now holds the render at 320, and the estimate follows the SAME math.
    expect(mosaicHeight(computeMosaicTiles(2, 700))).toBe(320);
  });

  it("4+ image rows estimate the 2-column grid math including gaps", () => {
    for (const count of [4, 5, 10]) {
      const attachments = Array.from({ length: count }, (_unused, index) => imageAttachment({ key: `img/${index}.png` }));
      const height = estimateRowHeight(messageOf({ attachments }), inputs({ usableWidth: 700 }));
      expect(height - textOnlyHeight(null)).toBe(mosaicHeight(computeMosaicTiles(count, 700)));
    }
  });

  it("a video card with known frame dims estimates the reserved box + name row", () => {
    const height = estimateRowHeight(
      messageOf({ attachments: [imageAttachment({ key: "vid/a.mp4", fileName: "a.mp4", width: 1920, height: 1080 })] }),
      inputs({ usableWidth: 700 }),
    );
    expect(height - textOnlyHeight(null)).toBe(reservedVideoThumbBox(1920, 1080, 700, 320).height + 24);
  });

  it("audio and plain files estimate the card height", () => {
    const audio = estimateRowHeight(messageOf({ attachments: [imageAttachment({ key: "a/a.mp3", fileName: "a.mp3" })] }), inputs());
    const plain = estimateRowHeight(messageOf({ attachments: [imageAttachment({ key: "a/a.zip", fileName: "a.zip" })] }), inputs());
    expect(audio - textOnlyHeight(null)).toBe(56);
    expect(plain - textOnlyHeight(null)).toBe(56);
  });
});

describe("estimateRowHeight — width-derived text lines", () => {
  it("a wider row fits more characters per line and estimates LOWER for the same text", () => {
    const content = "word ".repeat(60); // ~300 chars
    const narrow = estimateRowHeight(messageOf({ content }), inputs({ usableWidth: 400 }));
    const wide = estimateRowHeight(messageOf({ content }), inputs({ usableWidth: 900 }));
    expect(wide).toBeLessThan(narrow);
    expect(wide).toBeGreaterThan(0);
  });

  it("continuation rows estimate below head rows", () => {
    const head = estimateRowHeight(messageOf({ content: "hi" }), inputs({ startsGroup: true }));
    const continuation = estimateRowHeight(messageOf({ content: "hi" }), inputs({ startsGroup: false }));
    expect(continuation).toBe(head - 6);
  });
});

function replyLevel(nested: ReplyInfo | null = null, overrides: Partial<ReplyInfo> = {}): ReplyInfo {
  return {
    messageId: 1,
    authorId: 1,
    authorUsername: "alice",
    preview: "quoted text",
    createdAt: "2026-10-19T00:00:00Z",
    deleted: false,
    forward: null,
    reply: nested,
    ...overrides,
  };
}

/** A chain of `depth` levels: level N quotes level N+1. */
function replyChain(levels: number): ReplyInfo {
  let level: ReplyInfo | null = null;
  for (let index = 0; index < levels; index += 1) {
    level = replyLevel(level);
  }
  return level!;
}

describe("estimateRowHeight — the nested-reply quote stack (render mirror)", () => {
  it("a single-level reply costs one card, not the old flat 34", () => {
    const withReply = estimateRowHeight(messageOf({ reply: replyChain(1) }), inputs());
    expect(withReply - textOnlyHeight(null)).toBe(49);
  });

  it("a deep chain pays PER LEVEL (the ~200px gap that bounced the scrollbar)", () => {
    for (const levels of [2, 3, 5]) {
      const height = estimateRowHeight(messageOf({ reply: replyChain(levels) }), inputs());
      expect(height - textOnlyHeight(null)).toBe(levels * 49);
    }
  });

  it("the depth cutoff mirrors the render: chains past QUOTE_DEPTH_MAX+1 levels stop growing", () => {
    const rendered = estimateRowHeight(messageOf({ reply: replyChain(QUOTE_DEPTH_MAX + 1) }), inputs());
    const deeper = estimateRowHeight(messageOf({ reply: replyChain(QUOTE_DEPTH_MAX + 4) }), inputs());
    expect(rendered - textOnlyHeight(null)).toBe((QUOTE_DEPTH_MAX + 1) * 49);
    expect(deeper).toBe(rendered);
  });

  it("a deleted level renders the single italic marker and NOTHING below it", () => {
    const deletedTop = messageOf({ reply: replyLevel(replyChain(3), { deleted: true, preview: "" }) });
    expect(estimateRowHeight(deletedTop, inputs()) - textOnlyHeight(null)).toBe(30);
  });

  it("a level carrying the nested-forward context line pays for it", () => {
    const forwardContext: ForwardInfo = {
      serverName: "srv", channelName: "general", authorId: 2, authorUsername: "bob",
      createdAt: "2026-10-19T00:00:00Z", trusted: true, reply: null,
    };
    const height = estimateRowHeight(messageOf({ reply: replyLevel(null, { forward: forwardContext }) }), inputs());
    expect(height - textOnlyHeight(null)).toBe(49 + 16);
  });

  it("a forwarded message pays its card rows AND the frozen quote tree (one level deeper)", () => {
    const forward: ForwardInfo = {
      serverName: "srv", channelName: "general", authorId: 2, authorUsername: "bob",
      createdAt: "2026-10-19T00:00:00Z", trusted: true, reply: replyChain(2),
    };
    const height = estimateRowHeight(messageOf({ forward }), inputs());
    // 30 = the forward card's own two rows; the frozen tree renders from depth 1
    // — with the cutoff, a 2-level tree at depth 1..2 shows BOTH cards.
    expect(height - textOnlyHeight(null)).toBe(30 + 2 * 49);
  });
});
