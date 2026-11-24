import type { Channel } from "../../types";

/**
 * The sidebar's channel layout (Discord's model, 2026-11-24): ONE ordered
 * top-level ladder where FREE channels (no category) and CATEGORY blocks sit
 * INTERLEAVED — a channel can stand above, below or between categories. The
 * order is the server's single (position, id) staircase over every top-level
 * node; inside a category block text channels sit ABOVE voice channels (user
 * decision, unchanged), while FREE channels of both types share the ladder.
 *
 * Pure derivation over the store's snapshot — the Sidebar runs it in a useMemo
 * (the selector-identity contract: never inside a store selector).
 */

/** The manual sidebar order: (position, id). */
export function compareChannelOrder(left: Channel, right: Channel): number {
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.id - right.id;
}

/** A category block: the header's channel row plus its children, text above voice. */
export interface CategoryGroup {
  category: Channel;
  textChannels: Channel[];
  voiceChannels: Channel[];
}

/** One node of the top-level ladder: a free channel or a category block. */
export type TopLevelNode =
  | { kind: "free"; channel: Channel }
  | ({ kind: "category" } & CategoryGroup);

export interface ChannelGroups {
  /** The single interleaved ladder of free channels and category blocks. */
  topLevel: TopLevelNode[];
}

/** Groups the store snapshot. A channel whose parentId names a category NOT in
 *  the list (the viewer cannot see the category — the server filters
 *  per-channel) falls back to a free top-level node rather than disappearing. */
export function groupChannelsByCategory(channels: readonly Channel[]): ChannelGroups {
  // Pass 1: collect the categories (a child may arrive BEFORE its parent in
  // the snapshot — the layout pass must not depend on input order).
  const groupsById = new Map<number, CategoryGroup>();
  for (const channel of channels) {
    if (channel.type === "CATEGORY") {
      groupsById.set(channel.id, { category: channel, textChannels: [], voiceChannels: [] });
    }
  }
  // Pass 2: lay out the ladder. A channel whose parentId names a category NOT
  // in the map (the viewer cannot see it) falls back to a free node.
  const topLevelSeeds: Channel[] = [];
  for (const channel of channels) {
    if (channel.type !== "CATEGORY") {
      const group = channel.parentId !== null ? groupsById.get(channel.parentId) : undefined;
      if (group !== undefined) {
        if (channel.type === "VOICE") {
          group.voiceChannels.push(channel);
        } else {
          group.textChannels.push(channel);
        }
        continue;
      }
    }
    topLevelSeeds.push(channel);
  }
  topLevelSeeds.sort(compareChannelOrder);
  for (const group of groupsById.values()) {
    group.textChannels.sort(compareChannelOrder);
    group.voiceChannels.sort(compareChannelOrder);
  }
  return {
    topLevel: topLevelSeeds.map((channel): TopLevelNode => channel.type === "CATEGORY"
      ? { kind: "category", ...groupsById.get(channel.id)! }
      : { kind: "free", channel }),
  };
}

/** The persist body of a drag: the sidebar's ladder flattened into the server's
 *  ONE dense order — each free channel as it stands, each category row followed
 *  by its text and voice children. The server renumbers positions by list
 *  index; only ids and parents travel. */
export function flattenGroupsForPersist(groups: ChannelGroups): { id: number; parentId: number | null }[] {
  const entries: { id: number; parentId: number | null }[] = [];
  for (const node of groups.topLevel) {
    if (node.kind === "free") {
      entries.push({ id: node.channel.id, parentId: null });
      continue;
    }
    entries.push({ id: node.category.id, parentId: null });
    for (const channel of node.textChannels) {
      entries.push({ id: channel.id, parentId: node.category.id });
    }
    for (const channel of node.voiceChannels) {
      entries.push({ id: channel.id, parentId: node.category.id });
    }
  }
  return entries;
}
