/**
 * Pure message-grouping rules (Discord-style): a message CONTINUES the previous
 * group when the author is the same and the gap fits the window; otherwise it
 * STARTS a group (own avatar + name + timestamp header). Kept as a pure transform
 * over a minimal projection — the store maps wire messages into it, the renderer
 * never re-derives grouping inline.
 */

export interface GroupableMessage {
  id: number;
  authorUsername: string;
  createdAtEpochMs: number;
}

/** Discord uses a 5-minute window. */
export const GROUP_GAP_MS = 5 * 60_000;

export function computeGroupStarts(messages: readonly GroupableMessage[], gapMs: number = GROUP_GAP_MS): boolean[] {
  const flags: boolean[] = [];
  let previous: GroupableMessage | null = null;
  for (const message of messages) {
    flags.push(previous === null
      || previous.authorUsername !== message.authorUsername
      || message.createdAtEpochMs - previous.createdAtEpochMs > gapMs);
    previous = message;
  }
  return flags;
}

/** Wire createdAt (ISO string) → epoch ms, the grouping input. */
export function toEpochMs(createdAtIso: string): number {
  const parsed = Date.parse(createdAtIso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** "14:05" local time for the group head (locale-dependent by design, not unit-tested). */
export function formatTimeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
