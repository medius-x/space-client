/**
 * Pure math for the server-rail manual ordering (the Discord model — user request
 * 2026-10-19: the rail order is HAND-set, never derived from connection recency).
 * The directory's snapshot sort and the drag-and-drop's live preview/drop both run
 * through these functions, so what you see while dragging is exactly what lands
 * in the store.
 */

/**
 * Moves `draggedId` to the position relative to `targetId`: ABOVE the target row
 * when the cursor is in its upper half, below otherwise. `targetId` null = below
 * every row (append). Returns the input REFERENCE when nothing would change —
 * hovering the same spot must not churn the list (the moveRoleIdTowards contract).
 */
export function applyRailDrop(
  orderedIds: readonly string[],
  draggedId: string,
  targetId: string | null,
  belowTarget: boolean,
): readonly string[] {
  if (targetId !== null && targetId === draggedId) {
    return orderedIds;
  }
  const withoutDragged = orderedIds.filter((candidate) => candidate !== draggedId);
  let targetIndex: number;
  if (targetId === null) {
    targetIndex = withoutDragged.length;
  } else {
    const indexOfTarget = withoutDragged.indexOf(targetId);
    targetIndex = indexOfTarget < 0 ? withoutDragged.length : (belowTarget ? indexOfTarget + 1 : indexOfTarget);
  }
  targetIndex = Math.max(0, Math.min(targetIndex, withoutDragged.length));
  if (targetIndex === orderedIds.indexOf(draggedId)) {
    return orderedIds; // already sits exactly there
  }
  return [...withoutDragged.slice(0, targetIndex), draggedId, ...withoutDragged.slice(targetIndex)];
}

/**
 * The rail order itself: records listed in `order` come first in that sequence
 * (a duplicated id counts once — first occurrence wins), every record MISSING
 * from `order` is appended after them by `createdAt` ascending (join order —
 * new servers land at the bottom, like Discord), ties broken by `id` so the
 * result is fully deterministic. Dead ids in `order` (removed records) are
 * ignored. `lastUsedAt` deliberately plays NO part — sorting by it made the
 * rail reshuffle at every startup (parallel session starts bumped it in
 * completion order).
 */
export function sortRecordsForRail<T extends { id: string; createdAt: number }>(
  records: readonly T[],
  order: readonly string[],
): T[] {
  const positionOf = new Map<string, number>();
  for (const recordId of order) {
    if (!positionOf.has(recordId)) {
      positionOf.set(recordId, positionOf.size);
    }
  }
  const positioned: T[] = [];
  const unpositioned: T[] = [];
  for (const record of records) {
    if (positionOf.has(record.id)) {
      positioned.push(record);
    } else {
      unpositioned.push(record);
    }
  }
  positioned.sort((left, right) => (positionOf.get(left.id) ?? 0) - (positionOf.get(right.id) ?? 0));
  unpositioned.sort((left, right) =>
    left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1));
  return [...positioned, ...unpositioned];
}

/** Sanitizes the persisted order as read from disk: anything that is not a
 *  string array collapses to [], duplicates keep their first occurrence. */
export function sanitizeRailOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string") {
      seen.add(entry);
    }
  }
  return [...seen];
}
