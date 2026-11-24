import type { Channel } from "../../types";
import type { ChannelGroups, TopLevelNode } from "./channel-groups";

/**
 * The pure sidebar drag algebra (the roles' moveRoleIdTowards counterpart): the
 * pointer hit-test produces a DropTarget, this applies it to the grouped model
 * and returns the next groups — or null when nothing changed (the UI skips both
 * the optimistic preview and the persist).
 *
 * The ladder semantics (2026-11-24): free channels and category blocks share
 * ONE top-level order, so a channel dropped between top-level nodes becomes a
 * FREE channel standing between categories (Discord's model). Dropping a
 * channel ON a category header drops it INTO that category (the hit-test
 * translates the header row to a cat-* append target; also the
 * collapsed-category story); a category only moves along the top-level ladder.
 */

/** What the pointer grabbed: a TEXT/VOICE channel, or a whole category block. */
export type DragSubject =
  | { kind: "channel"; channel: Channel }
  | { kind: "category"; category: Channel };

/** Which ladder position the pointer dropped over. */
export type DropList = "top" | "cat-text" | "cat-voice";

export interface DropTarget {
  list: DropList;
  /** The owning category for the cat-* lists. */
  categoryId?: number;
  /** Insert BEFORE this node/channel id; null (or an id absent from the target
   *  list — e.g. a voice row the normalized list doesn't contain) appends. For
   *  the "top" list the id may name a free channel OR a category header. */
  beforeId: number | null;
}

/** Applies the drop to a grouped model. Mismatched drops normalize: a TEXT
 *  channel dropped over a voice row lands at the END of that block's TEXT list
 *  (the text-above-voice layout inside a category is fixed), and vice versa. A
 *  category dropped over anything but the top ladder is a no-op (null). */
export function applyChannelDrop(groups: ChannelGroups, subject: DragSubject, target: DropTarget): ChannelGroups | null {
  if (subject.kind === "category") {
    if (target.list !== "top") {
      return null;
    }
    const draggedNode = groups.topLevel.find((node): node is CategoryNode =>
      node.kind === "category" && node.category.id === subject.category.id);
    if (draggedNode === undefined) {
      return null; // a stale drag
    }
    const reduced: ChannelGroups = { topLevel: groups.topLevel.filter((node) => node !== draggedNode) };
    return withTopInserted(reduced, draggedNode, target.beforeId, groups);
  }

  const channel = subject.channel;
  // Phase 1: pull the subject out of its current spot (a fresh model, so the
  // insert below can never duplicate the dragged channel).
  const afterRemove = withoutChannel(groups, channel.id);
  if (afterRemove === null) {
    return null; // the subject is not in the model (a stale drag)
  }

  // Phase 2: insert. The "top" list needs no type normalization — free channels
  // of both types share the ladder; the cat-* lists normalize as before.
  if (target.list === "top") {
    return withTopInserted(afterRemove, { kind: "free", channel }, target.beforeId, groups);
  }
  let list = target.list;
  let beforeId = target.beforeId;
  const isVoice = channel.type === "VOICE";
  if (list === "cat-text" && isVoice) {
    list = "cat-voice";
    beforeId = null;
  } else if (list === "cat-voice" && !isVoice) {
    list = "cat-text";
    beforeId = null;
  }
  const categoryId = target.categoryId ?? null;
  if (categoryId === null) {
    return null; // a category list without its category — a stale hit-test
  }
  const group = afterRemove.topLevel.find((node): node is CategoryNode =>
    node.kind === "category" && node.category.id === categoryId);
  if (group === undefined) {
    return null;
  }
  const updated: CategoryNode = list === "cat-text"
    ? { ...group, textChannels: withInserted(group.textChannels, channel, beforeId) }
    : { ...group, voiceChannels: withInserted(group.voiceChannels, channel, beforeId) };
  const next: ChannelGroups = {
    topLevel: afterRemove.topLevel.map((node) => node === group ? updated : node),
  };
  return sameGroups(groups, next) ? null : next;
}

/** The category flavor of a top-level node (narrowing alias). */
type CategoryNode = Extract<TopLevelNode, { kind: "category" }>;

/** Inserts a top-level node before the node named by beforeId (a free channel
 *  or a category header) or appends; null when the ladder did not change. */
function withTopInserted(reduced: ChannelGroups, node: TopLevelNode, beforeId: number | null, original: ChannelGroups): ChannelGroups | null {
  const insertIndex = beforeId === null
    ? reduced.topLevel.length
    : reduced.topLevel.findIndex((candidate) => topLevelId(candidate) === beforeId);
  const at = insertIndex === -1 ? reduced.topLevel.length : insertIndex;
  const next: ChannelGroups = { topLevel: [...reduced.topLevel.slice(0, at), node, ...reduced.topLevel.slice(at)] };
  return sameGroups(original, next) ? null : next;
}

/** The id a top-level node is addressed by on the ladder. */
function topLevelId(node: TopLevelNode): number {
  return node.kind === "free" ? node.channel.id : node.category.id;
}

/** The model without one channel (its category block survives, maybe emptied). */
function withoutChannel(groups: ChannelGroups, channelId: number): ChannelGroups | null {
  const asFree = groups.topLevel.find((node) => node.kind === "free" && node.channel.id === channelId);
  if (asFree !== undefined) {
    return { topLevel: groups.topLevel.filter((node) => node !== asFree) };
  }
  for (const node of groups.topLevel) {
    if (node.kind !== "category") {
      continue;
    }
    const inText = node.textChannels.some((channel) => channel.id === channelId);
    const inVoice = node.voiceChannels.some((channel) => channel.id === channelId);
    if (inText || inVoice) {
      const updated: CategoryNode = {
        ...node,
        textChannels: inText ? node.textChannels.filter((channel) => channel.id !== channelId) : node.textChannels,
        voiceChannels: inVoice ? node.voiceChannels.filter((channel) => channel.id !== channelId) : node.voiceChannels,
      };
      return { topLevel: groups.topLevel.map((candidate) => candidate === node ? updated : candidate) };
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
  return left.topLevel.length === right.topLevel.length
    && left.topLevel.every((node, index) => sameNode(node, right.topLevel[index]!));
}

function sameNode(left: TopLevelNode, right: TopLevelNode): boolean {
  if (left === right) {
    return true;
  }
  if (left.kind === "free" && right.kind === "free") {
    return left.channel === right.channel;
  }
  if (left.kind === "category" && right.kind === "category") {
    return left.category === right.category
      && sameList(left.textChannels, right.textChannels)
      && sameList(left.voiceChannels, right.voiceChannels);
  }
  return false;
}

function sameList(left: readonly Channel[], right: readonly Channel[]): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}
