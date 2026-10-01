import type { Channel } from "../../types";

/**
 * The sidebar's channel grouping (Discord's categories): uncategorized TEXT
 * channels first, uncategorized VOICE after them, then one block per CATEGORY —
 * inside a block, text channels sit ABOVE voice channels (user decision), each
 * list ordered by the manual sidebar order (position, id).
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

export interface CategoryGroup {
  category: Channel;
  textChannels: Channel[];
  voiceChannels: Channel[];
}

export interface ChannelGroups {
  /** TEXT channels with no (visible) category. */
  uncategorizedText: Channel[];
  /** VOICE channels with no (visible) category. */
  uncategorizedVoice: Channel[];
  /** The categories in sidebar order. */
  categories: CategoryGroup[];
}

/** Groups the store snapshot. A channel whose parentId names a category NOT in
 *  the list (the viewer cannot see the category — the server filters
 *  per-channel) falls back to uncategorized rather than disappearing. */
export function groupChannelsByCategory(channels: readonly Channel[]): ChannelGroups {
  const categories: Channel[] = [];
  const categoryIds = new Set<number>();
  const rest: Channel[] = [];
  for (const channel of channels) {
    if (channel.type === "CATEGORY") {
      categories.push(channel);
      categoryIds.add(channel.id);
    } else {
      rest.push(channel);
    }
  }
  categories.sort(compareChannelOrder);

  const uncategorizedText: Channel[] = [];
  const uncategorizedVoice: Channel[] = [];
  const groupsById = new Map<number, CategoryGroup>();
  for (const category of categories) {
    groupsById.set(category.id, { category, textChannels: [], voiceChannels: [] });
  }
  for (const channel of rest) {
    const group = channel.parentId !== null ? groupsById.get(channel.parentId) : undefined;
    if (group === undefined) {
      // No category or an invisible one — top-level render.
      (channel.type === "VOICE" ? uncategorizedVoice : uncategorizedText).push(channel);
    } else if (channel.type === "VOICE") {
      group.voiceChannels.push(channel);
    } else {
      group.textChannels.push(channel);
    }
  }
  for (const group of groupsById.values()) {
    group.textChannels.sort(compareChannelOrder);
    group.voiceChannels.sort(compareChannelOrder);
  }
  uncategorizedText.sort(compareChannelOrder);
  uncategorizedVoice.sort(compareChannelOrder);
  return {
    uncategorizedText,
    uncategorizedVoice,
    categories: categories.map((category) => groupsById.get(category.id)!),
  };
}

/** The persist body of a drag: the sidebar's own block layout flattened into the
 *  server's ONE dense order — [uncategorized text, uncategorized voice, then per
 *  category: the category row followed by its text and voice children]. The
 *  server renumbers positions by list index; only ids and parents travel. */
export function flattenGroupsForPersist(groups: ChannelGroups): { id: number; parentId: number | null }[] {
  const entries: { id: number; parentId: number | null }[] = [];
  for (const channel of groups.uncategorizedText) {
    entries.push({ id: channel.id, parentId: null });
  }
  for (const channel of groups.uncategorizedVoice) {
    entries.push({ id: channel.id, parentId: null });
  }
  for (const group of groups.categories) {
    entries.push({ id: group.category.id, parentId: null });
    for (const channel of group.textChannels) {
      entries.push({ id: channel.id, parentId: group.category.id });
    }
    for (const channel of group.voiceChannels) {
      entries.push({ id: channel.id, parentId: group.category.id });
    }
  }
  return entries;
}
