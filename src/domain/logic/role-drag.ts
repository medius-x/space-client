/**
 * Pure math for the role-list drag-and-drop reorder (port of oak's
 * ServerSettingsWindow.moveDraggedTo). The live preview and the final drop
 * both run through this one function — the drop is idempotent with the
 * preview, exactly like the oak original.
 */

/**
 * Moves `roleId` to the position relative to `targetRoleId`: ABOVE the target
 * when the cursor is in its upper half, below otherwise. Hovering the pinned
 * `@everyone` row (targetRoleId null) appends to the end. Returns the input
 * reference when nothing would change (hovering the same spot must not churn
 * the list — React would re-render on every dragover tick).
 */
export function moveRoleIdTowards(
  orderedIds: readonly number[],
  roleId: number,
  targetRoleId: number | null,
  belowTarget: boolean,
): readonly number[] {
  if (targetRoleId !== null && targetRoleId === roleId) {
    return orderedIds;
  }
  const withoutDragged = orderedIds.filter((candidate) => candidate !== roleId);
  let targetIndex: number;
  if (targetRoleId === null) {
    targetIndex = withoutDragged.length; // over the pinned row → end of the list
  } else {
    const indexOfTarget = withoutDragged.indexOf(targetRoleId);
    targetIndex = indexOfTarget < 0 ? withoutDragged.length : (belowTarget ? indexOfTarget + 1 : indexOfTarget);
  }
  targetIndex = Math.max(0, Math.min(targetIndex, withoutDragged.length));
  if (targetIndex === orderedIds.indexOf(roleId)) {
    return orderedIds; // already sits exactly there
  }
  return [...withoutDragged.slice(0, targetIndex), roleId, ...withoutDragged.slice(targetIndex)];
}
