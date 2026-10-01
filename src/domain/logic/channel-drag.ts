import type { Channel } from "../../types";
import type { ChannelGroups } from "./channel-groups";

/**
 * The pure sidebar drag algebra (the roles' moveRoleIdTowards counterpart): the
 * pointer hit-test produces a DropTarget, this applies it to the grouped model
 * and returns the next groups — or null when nothing changed (the UI skips both
 * the optimistic preview and the persist).
 */

/** What the pointer grabbed: a TEXT/VOICE channel, or a whole category block. */
export type DragSubject =
  | { kind: "channel"; channel: Channel }
  | { kind: "category"; category: Channel };

/** Which list the pointer dropped over. */
export type DropList = "uncat-text" | "uncat-voice" | "cat-text" | "cat-voice" | "categories";

export interface DropTarget {
  list: DropList;
  /** The owning category for the cat-* lists. */
  categoryId?: number;
  /** Insert BEFORE this channel/category id; null (or an id absent from the
   *  target list — e.g. a voice row the normalized list doesn't contain) appends. */
  beforeId: number | null;
}

/** Applies the drop to a grouped model. Mismatched drops normalize: a TEXT
 *  channel dropped over a voice row lands at the END of that block's TEXT list
 *  (the text-above-voice layout is fixed), and vice versa. A category only
 *  moves within the categories row — anything else is a no-op (null). */
export function applyChannelDrop(groups: ChannelGroups, subject: DragSubject, target: DropTarget): ChannelGroups | null {
  if (subject.kind === "category") {
    if (target.list !== "categories") {
      return null;
    }
    const dragged = groups.categories.find((group) => group.category.id === subject.category.id);
    if (dragged === undefined) {
      return null;
    }
    const rest = groups.categories.filter((group) => group.category.id !== subject.category.id);
    const insertIndex = target.beforeId === null
      ? rest.length
      : rest.findIndex((group) => group.category.id === target.beforeId);
    const at = insertIndex === -1 ? rest.length : insertIndex;
    const next = [...rest.slice(0, at), dragged, ...rest.slice(at)];
    return sameGroups(groups, { ...groups, categories: next }) ? null : { ...groups, categories: next };
  }

  const channel = subject.channel;
  const isVoice = channel.type === "VOICE";
  // A channel dropped ON a category header drops INTO that category (Discord):
  // the end of its matching-type list — also the collapsed-category story.
  if (target.list === "categories") {
    if (target.categoryId === undefined) {
      return null;
    }
    return applyChannelDrop(groups, subject, {
      list: isVoice ? "cat-voice" : "cat-text",
      categoryId: target.categoryId,
      beforeId: null,
    });
  }
  // Normalize a type-mismatched drop (text over a voice row → that block's text list, append).
  let list = target.list;
  let beforeId = target.beforeId;
  if (list === "uncat-text" && isVoice) {
    list = "uncat-voice";
    beforeId = null;
  } else if (list === "uncat-voice" && !isVoice) {
    list = "uncat-text";
    beforeId = null;
  } else if (list === "cat-text" && isVoice) {
    list = "cat-voice";
    beforeId = null;
  } else if (list === "cat-voice" && !isVoice) {
    list = "cat-text";
    beforeId = null;
  }

  // Phase 1: pull the subject out of its current list (a fresh model, so the
  // insert below can never duplicate the dragged channel).
  const afterRemove = withoutChannel(groups, channel.id);
  if (afterRemove === null) {
    return null; // the subject is not in the model (a stale drag)
  }

  // Phase 2: insert into the target list of the REDUCED model.
  let next: ChannelGroups;
  if (list === "uncat-text") {
    next = { ...afterRemove, uncategorizedText: withInserted(afterRemove.uncategorizedText, channel, beforeId) };
  } else if (list === "uncat-voice") {
    next = { ...afterRemove, uncategorizedVoice: withInserted(afterRemove.uncategorizedVoice, channel, beforeId) };
  } else {
    const categoryId = target.categoryId ?? null;
    if (categoryId === null) {
      return null; // a category list without its category — a stale hit-test
    }
    const group = afterRemove.categories.find((candidate) => candidate.category.id === categoryId);
    if (group === undefined) {
      return null;
    }
    const updated = list === "cat-text"
      ? { ...group, textChannels: withInserted(group.textChannels, channel, beforeId) }
      : { ...group, voiceChannels: withInserted(group.voiceChannels, channel, beforeId) };
    next = {
      ...afterRemove,
      categories: afterRemove.categories.map((candidate) => candidate === group ? updated : candidate),
    };
  }
  return sameGroups(groups, next) ? null : next;
}

/** The model without one channel (its category block survives, maybe emptied). */
function withoutChannel(groups: ChannelGroups, channelId: number): ChannelGroups | null {
  if (groups.uncategorizedText.some((channel) => channel.id === channelId)) {
    return { ...groups, uncategorizedText: groups.uncategorizedText.filter((channel) => channel.id !== channelId) };
  }
  if (groups.uncategorizedVoice.some((channel) => channel.id === channelId)) {
    return { ...groups, uncategorizedVoice: groups.uncategorizedVoice.filter((channel) => channel.id !== channelId) };
  }
  for (const group of groups.categories) {
    const inText = group.textChannels.some((channel) => channel.id === channelId);
    const inVoice = group.voiceChannels.some((channel) => channel.id === channelId);
    if (inText || inVoice) {
      const updated = {
        ...group,
        textChannels: inText ? group.textChannels.filter((channel) => channel.id !== channelId) : group.textChannels,
        voiceChannels: inVoice ? group.voiceChannels.filter((channel) => channel.id !== channelId) : group.voiceChannels,
      };
      return { ...groups, categories: groups.categories.map((candidate) => candidate === group ? updated : candidate) };
    }
  }
  return null;
}

/** Inserts before the id (or appends when the id is absent/null). */
function withInserted(list: readonly Channel[], channel: Channel, beforeId: number | null): Channel[] {
  const insertIndex = beforeId === null
    ? list.length
    : list.findIndex((candidate) => candidate.id === beforeId);
  const at = insertIndex === -1 ? list.length : insertIndex;
  return [...list.slice(0, at), channel, ...list.slice(at)];
}

/** Reference-per-element equality — a no-op drop produced new arrays with the
 *  same elements, and the caller must be able to skip the persist. */
function sameGroups(left: ChannelGroups, right: ChannelGroups): boolean {
  return sameList(left.uncategorizedText, right.uncategorizedText)
    && sameList(left.uncategorizedVoice, right.uncategorizedVoice)
    && left.categories.length === right.categories.length
    && left.categories.every((group, index) => {
      const other = right.categories[index]!;
      return group === other
        || (group.category === other.category
          && sameList(group.textChannels, other.textChannels)
          && sameList(group.voiceChannels, other.voiceChannels));
    });
}

function sameList(left: readonly Channel[], right: readonly Channel[]): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}
