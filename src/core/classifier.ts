import type { FeedInfo } from "../types";

/**
 * Pure stream bookkeeping — the exact invariants the Java client learned the hard way.
 *
 * 1. Voice vs share-audio classification is by MINDEX ONLY (labels never cross the
 *    wire): per publisher, the enabled audio stream with the LOWEST mindex is the VOICE;
 *    every further enabled audio mid is share audio.
 * 2. The subscriber PC has TWO mid spaces: the transceiver's own mid (slot) ≠ the
 *    subscribed stream mid. attached/updated events carry both; slot mids go stale after
 *    unwatch/reshare slot reuse, so routing NEVER trusts transceiver.mid.
 */

export interface FeedClassification {
  voiceMid: string | undefined;
  shareAudioMids: string[];
  videoMids: string[];
}

export function classifyFeed(feed: FeedInfo): FeedClassification {
  const enabledAudio = feed.streams
    .filter((stream) => stream.type === "audio" && !stream.disabled)
    .sort((left, right) => left.mindex - right.mindex);
  const videoMids = feed.streams
    .filter((stream) => stream.type === "video" && !stream.disabled)
    .sort((left, right) => left.mindex - right.mindex)
    .map((stream) => stream.mid);
  const [voice, ...shareAudio] = enabledAudio;
  return {
    voiceMid: voice?.mid,
    shareAudioMids: shareAudio.map((stream) => stream.mid),
    videoMids,
  };
}

/**
 * Whether the feed carries a LIVE screen/camera right now. Janus keeps a
 * STOPPED share's streams listed on the feed, merely disabled — counting
 * `type === "video"` without the flag renders a ghost share in every UI that
 * trusts it (the "Watch screen"/"sharing screen" bug).
 */
export function feedHasLiveVideo(feed: FeedInfo): boolean {
  return feed.streams.some((stream) => stream.type === "video" && !stream.disabled);
}

/** Whether the feed currently carries SHARE audio (a video-only share answers
 *  false — the pop-out's volume control disables itself on it). Two or more
 *  enabled audio streams = the publisher's voice plus at least one share
 *  track, per the lowest-mindex-is-voice invariant of classifyFeed. */
export function feedHasShareAudio(feed: FeedInfo): boolean {
  return feed.streams.filter((stream) => stream.type === "audio" && !stream.disabled).length >= 2;
}

export interface StreamRef {
  feed: number;
  mid: string;
}

/**
 * Which streams we want on the wire: everyone's VOICE always; video + its paired share
 * audio only for feeds we are actively viewing (bandwidth discipline — mirrors the Java
 * client: the share is heard only while watched).
 */
export function wantedStreams(feeds: FeedInfo[], viewedFeedIds: ReadonlySet<number>): StreamRef[] {
  const wanted: StreamRef[] = [];
  for (const feed of feeds) {
    const classification = classifyFeed(feed);
    if (classification.voiceMid !== undefined) {
      wanted.push({ feed: feed.feedId, mid: classification.voiceMid });
    }
    if (!viewedFeedIds.has(feed.feedId)) {
      continue;
    }
    for (const videoMid of classification.videoMids) {
      wanted.push({ feed: feed.feedId, mid: videoMid });
    }
    for (const shareMid of classification.shareAudioMids) {
      wanted.push({ feed: feed.feedId, mid: shareMid });
    }
  }
  return wanted;
}

export function streamKey(ref: StreamRef): string {
  return `${ref.feed}:${ref.mid}`;
}

export interface SubscriptionDiff {
  subscribe: StreamRef[];
  unsubscribe: StreamRef[];
}

/** Set-difference of subscriptions keyed by "feed:mid". */
export function diffSubscriptions(current: ReadonlySet<string>, wanted: StreamRef[]): SubscriptionDiff {
  const wantedKeys = new Set(wanted.map(streamKey));
  const subscribe: StreamRef[] = [];
  for (const ref of wanted) {
    if (!current.has(streamKey(ref))) {
      subscribe.push(ref);
    }
  }
  const unsubscribe: StreamRef[] = [];
  for (const key of current) {
    if (!wantedKeys.has(key)) {
      const [feedPart = "", midPart = ""] = key.split(":");
      unsubscribe.push({ feed: Number(feedPart), mid: midPart });
    }
  }
  return { subscribe, unsubscribe };
}

/** slot mid → (feedId, stream mid). Written from attached/updated; the ONLY routing truth. */
export class SlotMidTranslator {
  private readonly bySlot = new Map<string, { feedId: number; streamMid: string }>();

  onAttached(slotMid: string, feedId: number, streamMid: string): void {
    this.bySlot.set(slotMid, { feedId, streamMid });
  }

  resolve(slotMid: string): { feedId: number; streamMid: string } | undefined {
    return this.bySlot.get(slotMid);
  }

  forgetFeed(feedId: number): void {
    for (const [slotMid, entry] of this.bySlot) {
      if (entry.feedId === feedId) {
        this.bySlot.delete(slotMid);
      }
    }
  }

  clear(): void {
    this.bySlot.clear();
  }
}
