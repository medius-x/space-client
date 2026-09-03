import type { FeedStream } from "../types";

/**
 * Pure parsing of videoroom plugindata into a typed union. The consumed event vocabulary
 * is exactly what the Java client consumed: joined / event / attached / updated / updating /
 * destroyed, plus the error pair (426 room vanished, 433 bad pin) surfaced by join answers.
 */

export interface PublisherEntry {
  feedId: number;
  display: string;
  streams: FeedStream[];
}

/** An attached/updated stream entry — carries BOTH mid spaces (slot vs feed stream). */
export interface AttachedStream {
  slotMid: string;
  feedId: number;
  streamMid: string;
}

export type VideoroomEvent =
  | { kind: "joined"; publishers: PublisherEntry[] }
  | {
      kind: "event";
      publishers?: PublisherEntry[];
      unpublished?: number;
      leaving?: number;
    }
  | { kind: "attached" | "updated"; streams: AttachedStream[] }
  | { kind: "updating" }
  | { kind: "destroyed" }
  | { kind: "error"; errorCode: number; errorMessage: string };

function parseStreams(raw: unknown): FeedStream[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const streams: FeedStream[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.type !== "audio" && record.type !== "video") {
      continue;
    }
    if (typeof record.mid !== "string" || typeof record.mindex !== "number") {
      continue;
    }
    streams.push({
      type: record.type,
      mid: record.mid,
      mindex: record.mindex,
      disabled: record.disabled === true,
    });
  }
  return streams;
}

function parsePublishers(raw: unknown): PublisherEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const publishers: PublisherEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.display !== "string") {
      continue;
    }
    publishers.push({
      feedId: record.id,
      display: record.display,
      streams: parseStreams(record.streams),
    });
  }
  return publishers;
}

function parseAttachedStreams(raw: unknown): AttachedStream[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const streams: AttachedStream[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.mid !== "string" || typeof record.feed_id !== "number" || typeof record.feed_mid !== "string") {
      continue;
    }
    streams.push({ slotMid: record.mid, feedId: record.feed_id, streamMid: record.feed_mid });
  }
  return streams;
}

/** plugindata.data (the videoroom object) → typed event; null when nothing consumable. */
export function parseVideoroomData(data: unknown): VideoroomEvent | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.error_code === "number") {
    return {
      kind: "error",
      errorCode: record.error_code,
      errorMessage: typeof record.error === "string" ? record.error : "videoroom error",
    };
  }
  switch (record.videoroom) {
    case "joined":
      return { kind: "joined", publishers: parsePublishers(record.publishers) };
    case "event": {
      const hasPublishers = record.publishers !== undefined;
      const hasUnpublished = typeof record.unpublished === "number";
      const hasLeaving = typeof record.leaving === "number";
      if (!hasPublishers && !hasUnpublished && !hasLeaving) {
        return null; // e.g. a data-channel-only event we do not consume
      }
      return {
        kind: "event",
        publishers: hasPublishers ? parsePublishers(record.publishers) : undefined,
        unpublished: hasUnpublished ? (record.unpublished as number) : undefined,
        leaving: hasLeaving ? (record.leaving as number) : undefined,
      };
    }
    case "attached":
    case "updated": {
      const streams = parseAttachedStreams(record.streams);
      return streams.length > 0 ? { kind: record.videoroom, streams } : null;
    }
    case "updating":
      return { kind: "updating" };
    case "destroyed":
      return { kind: "destroyed" };
    default:
      return null;
  }
}

export function isRoomVanished(event: VideoroomEvent): boolean {
  return event.kind === "error" && event.errorCode === 426;
}

export function isBadPin(event: VideoroomEvent): boolean {
  return event.kind === "error" && event.errorCode === 433;
}
