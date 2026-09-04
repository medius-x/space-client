/**
 * Pure window math for the VirtualList: cumulative offsets over per-item heights
 * (measured, or estimates until measured) and a binary-searched visible window.
 * Kept pure so the 10k/60fps behavior is unit-testable without a DOM.
 */

/** Cumulative top-offsets: offsets[index] = top of item index; length = count + 1. */
export function buildCumulativeOffsets(heights: readonly number[]): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let index = 0; index < heights.length; index++) {
    offsets[index + 1] = (offsets[index] ?? 0) + Math.max(1, heights[index] ?? 0);
  }
  return offsets;
}

/** Index of the item containing the given pixel offset (last item clamps). */
export function indexAtOffset(offsets: Float64Array, offset: number): number {
  let low = 0;
  let high = offsets.length - 2; // last item index
  if (high < 0) {
    return 0;
  }
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((offsets[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export interface VirtualWindowInput {
  offsets: Float64Array;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

export interface VirtualWindow {
  startIndex: number;
  /** Inclusive end index. */
  endIndex: number;
}

export function computeWindow(input: VirtualWindowInput): VirtualWindow {
  const count = input.offsets.length - 1;
  if (count === 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  const firstVisible = indexAtOffset(input.offsets, Math.max(0, input.scrollTop));
  const lastVisible = indexAtOffset(input.offsets, Math.max(0, input.scrollTop + input.viewportHeight));
  return {
    startIndex: Math.max(0, firstVisible - input.overscan),
    endIndex: Math.min(count - 1, lastVisible + input.overscan),
  };
}

/** The scrollTop that puts item `index` at the viewport top (align "start"). */
export function offsetForIndexAlignStart(offsets: Float64Array, index: number): number {
  return offsets[Math.min(Math.max(0, index), offsets.length - 2)] ?? 0;
}

/** The scrollTop that centers item `index` in the viewport. */
export function offsetForIndexAlignCenter(offsets: Float64Array, index: number, viewportHeight: number): number {
  const clamped = Math.min(Math.max(0, index), offsets.length - 2);
  const itemTop = offsets[clamped] ?? 0;
  const itemHeight = (offsets[clamped + 1] ?? 0) - itemTop;
  return Math.max(0, itemTop - (viewportHeight - itemHeight) / 2);
}
