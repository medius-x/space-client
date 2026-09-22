import type { Discussion } from "../../types";

/** The per-channel tracked-discussion counts for the sidebar badges: one entry per channel
 *  (in the CHANNEL LIST's order — the caller's channels array), value = the channel's tracked
 *  count. Channels with zero tracked discussions are omitted from the map. */
export function groupMineByChannel(mine: readonly Discussion[], channelIds: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  const knownChannels = new Set(channelIds);
  for (const discussion of mine) {
    if (!discussion.tracked || !knownChannels.has(discussion.parentChannelId)) {
      continue;
    }
    counts.set(discussion.parentChannelId, (counts.get(discussion.parentChannelId) ?? 0) + 1);
  }
  return counts;
}

/** The tracked list ordered most-recently-active first (nulls last — a thread with no replies
 *  yet has no activity moment; ties keep the input order, i.e. the server's id order). */
export function sortMineByActivity(mine: readonly Discussion[]): Discussion[] {
  return [...mine].sort((left, right) => {
    const leftAt = left.lastMessageAt ?? "";
    const rightAt = right.lastMessageAt ?? "";
    if (leftAt === rightAt) {
      return 0;
    }
    if (leftAt === "") {
      return 1; // nulls last
    }
    if (rightAt === "") {
      return -1;
    }
    return leftAt > rightAt ? -1 : 1;
  });
}

/** The tile label under an origin message: "Discussion" before the first reply, then with the
 *  count ("Discussion · 3 replies"). */
export function tileReplyLabel(discussion: Discussion): string {
  return discussion.replyCount === 0
    ? "Discussion"
    : `Discussion · ${discussion.replyCount} ${discussion.replyCount === 1 ? "reply" : "replies"}`;
}
