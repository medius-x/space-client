import type { Message, ReplyInfo } from "../../types";
import {
  computeMosaicTiles,
  isAudioFile,
  isImageFile,
  isVideoFile,
  mosaicHeight,
  reservedVideoThumbBox,
  singleTileBox,
} from "./attachment-layout";
import { jumboEmojiEstimateExtra } from "./emoji-picker";
import { stickerEstimateExtra } from "./sticker-picker";

/**
 * Content-aware height estimate for a chat row — the ESTIMATE IS THE FIRST
 * PAINT contract: a virtualized row is born with this height and measurement
 * replaces it a frame later; any estimate≠render delta shifts every row below
 * and, while scrolling UP, repeatedly throws the viewport back down through
 * image-heavy history (live report 2026-10-19: "the scrollbar bounces back").
 * Hence the two rules this module enforces:
 *
 *  1. the SAME pure layout math the renderer uses (computeMosaicTiles/
 *     mosaicHeight/singleTileBox/reservedVideoThumbBox) — never independent
 *     magic numbers that drift from the render;
 *  2. the SAME usable width (the caller passes the live measured width the
 *     AttachmentView measured; the old hardcoded 480 underestimated every
 *     image row by 100-170px at real ~700px).
 *
 * The remaining approximation is text wrapping (chars-per-line is a font
 * metric, not layout math) — bounded to ±a line, an order of magnitude below
 * the old image deltas.
 */
export interface RowHeightInputs {
  startsGroup: boolean;
  hasDiscussionTile: boolean;
  jumboEmojiPx: number;
  usableWidth: number;
  /** Intrinsic dims for LEGACY attachments (sent before the wire carried
   *  width/height) by stable key — the renderer's learned cache, injected so
   *  this module stays renderer-free. Null → the placeholder square, exactly
   *  what the first paint shows for an unknown image. */
  knownDimsOf(key: string | null): { width: number; height: number } | null;
}

/** ~7px average glyph at the 13px body font; floored so a narrow window never
 *  spirals into absurd line counts. Width-derived — the old flat 72 fit the
 *  480px assumption, not the reader's window. */
function charsPerLine(usableWidth: number): number {
  return Math.max(40, Math.floor(usableWidth / 7));
}

/** The renderer's quote-stack cutoff (QuoteCard renders depth 0..5 — a card at
 *  depth 5 shows no children). Single source for the render and the estimate. */
export const QUOTE_DEPTH_MAX = 5;

/** One quote-card level from the CSS: padding 8 + vertical margin 6 + head
 *  line 17 + one-line preview 16 (nowrap/ellipsis — ALWAYS one line) + 2px of
 *  column gaps. */
const QUOTE_LEVEL_HEIGHT = 49;
/** The nested-forward context line ("↗ from …", 11px + gap). */
const QUOTE_FORWARD_LINE_HEIGHT = 16;
/** The deleted marker renders a single italic line — and NO children. */
const QUOTE_DELETED_HEIGHT = 30;

/** Mirrors QuoteCard's recursive render: a card per chain level up to the
 *  depth cutoff, the forward-context line where present, and NOTHING below a
 *  deleted level. The old flat +34 per MESSAGE underestimated deep chains by
 *  ~200px — the same scroll-up bounce the image rows had (live report
 *  2026-10-19: "nested replies"). */
function quoteStackHeight(level: ReplyInfo, depth: number): number {
  if (level.deleted) {
    return QUOTE_DELETED_HEIGHT;
  }
  const child = level.reply !== null && depth < QUOTE_DEPTH_MAX
    ? quoteStackHeight(level.reply, depth + 1)
    : 0;
  return QUOTE_LEVEL_HEIGHT
    + (level.forward !== null ? QUOTE_FORWARD_LINE_HEIGHT : 0)
    + child;
}

export function estimateRowHeight(message: Message, inputs: RowHeightInputs): number {
  const lines = message.content === null ? 0 : Math.max(1, Math.ceil(message.content.length / charsPerLine(inputs.usableWidth)));
  let height = (inputs.startsGroup ? 30 : 24) + lines * 21;
  // A potentially-jumbo row (emoji-only content) grows with the reader's size
  // setting — prepaid here so measurement does not shift rows below it.
  height += jumboEmojiEstimateExtra(message.content, inputs.jumboEmojiPx);
  // The sticker block renders at a FIXED height, so its prepayment is exact.
  height += stickerEstimateExtra(message.sticker);
  if (message.reply !== null) {
    height += quoteStackHeight(message.reply, 0);
  }
  if (message.forward !== null) {
    // The forward card's own two rows (origin + author) plus the FROZEN quote
    // tree it renders inside (starting one level deeper than a live reply).
    height += 30 + (message.forward.reply !== null ? quoteStackHeight(message.forward.reply, 1) : 0);
  }
  if (message.reactions.length > 0) {
    height += 26;
  }
  if (inputs.hasDiscussionTile) {
    height += 24;
  }
  // Attachments — mirrored from AttachmentView's own math at the same width.
  let attachmentEstimate = 0;
  let imageTiles = 0;
  let singleImage: { width: number; height: number } | null = null;
  for (const attachment of message.attachments) {
    const known = attachment.width !== null && attachment.height !== null
      ? { width: attachment.width, height: attachment.height }
      : inputs.knownDimsOf(attachment.key);
    if (isImageFile(attachment.fileName)) {
      imageTiles += 1;
      if (singleImage === null) {
        singleImage = known;
      }
    } else if (isVideoFile(attachment.fileName)) {
      attachmentEstimate += known !== null
        ? reservedVideoThumbBox(known.width, known.height, inputs.usableWidth, 320).height + 24
        : 340; // unknown aspect — the historical flat card
    } else if (isAudioFile(attachment.fileName)) {
      attachmentEstimate += 56;
    } else {
      attachmentEstimate += 56; // the plain-file card (the audio-card height)
    }
  }
  if (imageTiles > 0) {
    const tiles = Math.min(imageTiles, 10);
    attachmentEstimate += tiles === 1
      ? singleTileBox(inputs.usableWidth, singleImage?.width ?? 0, singleImage?.height ?? 0).height
      : mosaicHeight(computeMosaicTiles(tiles, inputs.usableWidth));
  }
  height += attachmentEstimate;
  return height;
}
