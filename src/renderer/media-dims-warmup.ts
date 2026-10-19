import type { Message } from "../types";
import { isImageFile, isVideoFile } from "../domain/logic/attachment-layout";
import { log } from "../logging";
import { learnedDims, rememberDims } from "./media-dims";

/**
 * Warm the learned-dimensions cache for LEGACY attachments AHEAD of the
 * scroll (2026-10-19, the "heavy images bounce the scrollbar" report): a row
 * whose media carries no wire dimensions and whose key the cache has never
 * seen mounts with a FALLBACK box and re-measures after the decode — that
 * height jump is what the virtualizer's first-measure compensation turns into
 * thumb jerks while scrolling up through an image-heavy history.
 *
 * The warmup walks the loaded list, picks unmeasured legacy images and video
 * thumbnails, and decodes them one at a time through the attachment cache
 * (disk cache, network and the negative dead-key cache all apply — a sweep
 * over a channel with dead links stays cheap). Best-effort by design: a newer
 * call supersedes the older sweep; nothing here is load-bearing for
 * correctness, only for scroll smoothness.
 */

/** One sweep warms at most a history page's worth of unmeasured media. */
const WARMUP_MAX_ITEMS = 48;

interface WarmupTarget {
  key: string;
  url: string | null;
}

interface WarmupCache {
  loadImage(spec: { key: string; url: string | null }): Promise<string | null>;
}

let runCounter = 0;

function targetOf(attachment: Message["attachments"][number]): WarmupTarget | null {
  // New rows carry wire dimensions — only legacy keys need learning, and only
  // while the cache has nothing for them yet.
  if ((attachment.width ?? 0) > 0 || (attachment.height ?? 0) > 0) {
    return null;
  }
  if (isImageFile(attachment.fileName) && attachment.key !== null) {
    return learnedDims(attachment.key) === null
      ? { key: attachment.key, url: attachment.url }
      : null;
  }
  // A legacy video reserves its card through the PREVIEW's aspect — the
  // preview JPEG shares the frame's aspect, so learning the thumb is enough.
  if (isVideoFile(attachment.fileName) && attachment.thumbnailKey !== null) {
    return learnedDims(attachment.thumbnailKey) === null
      ? { key: attachment.thumbnailKey, url: attachment.thumbnailUrl }
      : null;
  }
  return null;
}

/** Decode the unmeasured legacy media of a loaded message list, oldest-first
 * (history is prepended ABOVE — the cold rows the reader is scrolling into). */
export function warmLegacyAttachmentDims(messages: readonly Message[], cache: WarmupCache): void {
  const runId = ++runCounter;
  const targets: WarmupTarget[] = [];
  for (const message of messages) {
    if (targets.length >= WARMUP_MAX_ITEMS) {
      break;
    }
    for (const attachment of message.attachments) {
      if (targets.length >= WARMUP_MAX_ITEMS) {
        break;
      }
      const target = targetOf(attachment);
      if (target !== null) {
        targets.push(target);
      }
    }
  }
  if (targets.length === 0) {
    return;
  }
  const warmNext = (index: number): void => {
    if (runId !== runCounter) {
      return; // a newer sweep superseded this one
    }
    const target = targets[index];
    if (target === undefined) {
      log.info("media", `dims warmup: learned ${targets.length} legacy attachment size(s)`);
      return;
    }
    void cache.loadImage(target).then((objectUrl) => {
      if (objectUrl !== null) {
        const image = new Image();
        image.src = objectUrl;
        void image.decode().catch(() => undefined).then(() => {
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            rememberDims(target.key, image.naturalWidth, image.naturalHeight);
          }
          warmNext(index + 1);
        });
      } else {
        warmNext(index + 1);
      }
    });
  };
  warmNext(0);
}
