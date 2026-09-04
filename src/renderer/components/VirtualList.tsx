import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildCumulativeOffsets,
  computeWindow,
  offsetForIndexAlignCenter,
  offsetForIndexAlignStart,
} from "../../domain/logic/virtual-window";
import { virtualScrollTelemetry } from "../scroll-telemetry";

/**
 * Own virtualized list (the plan's ~300-line bet instead of a dependency):
 * variable heights start from an ESTIMATE and get measured after layout
 * (data-key elements, 0.5px tolerance), the window is the pure math from
 * domain/logic/virtual-window, and a PREPEND restores the scroll anchor on the
 * OLD FIRST ITEM — back-filled history never jumps the viewport.
 */
export interface VirtualListHandle {
  scrollToKey(key: string, align?: "start" | "center"): boolean;
  scrollTop(): number;
  viewportHeight(): number;
  scrollToBottom(): void;
}

export const NEAR_TOP_THRESHOLD = 80;
export const NEAR_BOTTOM_THRESHOLD = 80;

const OVERSCAN = 6;
/**
 * The estimate for never-measured rows FREEZES after this many measurements. A
 * running average would keep sliding totalHeight as new regions get measured
 * (on a 10k list that never converges), and every slide re-maps the scrollbar
 * thumb — the cursor visibly outruns it forever. Frozen, the total only moves
 * on local estimate→measure transitions inside the visible window.
 */
const ESTIMATE_FREEZE_AFTER = 60;
/** A scroll event this close after a wheel tick is wheel-driven, not a thumb drag. */
const WHEEL_FRESHNESS_MS = 150;
/** Scroll silence that ends an inferred drag and lands the deferred refinements. */
const SCROLL_IDLE_MS = 150;

interface VirtualListProps<Item> {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  estimateHeight: (item: Item) => number;
  renderItem: (item: Item, index: number) => React.ReactNode;
  /** Fires while the viewport sits within NEAR_TOP_THRESHOLD of the top. */
  onNearTop?: () => void;
  /** Bottom-proximity signal for the caller's stick-to-bottom logic. */
  onBottomProximity?: (nearBottom: boolean) => void;
  className?: string;
  ref?: React.Ref<VirtualListHandle>;
}

export function VirtualList<Item>(props: VirtualListProps<Item>): React.JSX.Element {
  const { items, itemKey, estimateHeight, renderItem, onNearTop, onBottomProximity, className, ref } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const measuredHeights = useRef(new Map<string, number>());
  const measuredCountRef = useRef(0);
  const measuredSumRef = useRef(0);
  const frozenEstimateRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [measureVersion, setMeasureVersion] = useState(0);
  void measureVersion; // bumping it recomputes the offsets memo below

  // Thumb-lock contract: while a scrollbar DRAG is inferred (scrolling without any
  // recent wheel input), measurement refinements must NOT move the scroll extent —
  // they accumulate and land as ONE visible jump when the drag stops. Real content
  // loads (items change) unfreeze immediately, so the thumb jumps at the load —
  // the Chrome-on-a-lazy-page behavior.
  const [canvasFrozen, setCanvasFrozen] = useState(false);
  const frozenTotalRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const scrollIdleTimerRef = useRef<number | null>(null);

  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < items.length; index++) {
      map.set(itemKey(items[index]!), index);
    }
    return map;
  }, [items, itemKey]);

  const offsets = useMemo(() => {
    const calibratedEstimate = frozenEstimateRef.current;
    const heights = items.map((item) =>
      measuredHeights.current.get(itemKey(item)) ?? calibratedEstimate ?? estimateHeight(item));
    return buildCumulativeOffsets(heights);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measureVersion is the heights' identity
  }, [items, itemKey, estimateHeight, measureVersion]);

  const totalHeight = offsets.length > 0 ? offsets[offsets.length - 1]! : 0;
  const windowRange = useMemo(
    () => computeWindow({ offsets, scrollTop, viewportHeight, overscan: OVERSCAN }),
    [offsets, scrollTop, viewportHeight],
  );

  // Measure rendered rows BEFORE paint; changed heights recompute offsets in the same frame.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let changed = false;
    for (const element of container.querySelectorAll<HTMLElement>("[data-vkey]")) {
      const key = element.dataset.vkey;
      if (key === undefined) {
        continue;
      }
      const height = element.offsetHeight;
      const previous = measuredHeights.current.get(key);
      if (previous === undefined) {
        measuredHeights.current.set(key, height);
        measuredCountRef.current += 1;
        measuredSumRef.current += height;
        changed = true;
      } else if (Math.abs(previous - height) > 0.5) {
        measuredHeights.current.set(key, height);
        measuredSumRef.current += height - previous;
        changed = true;
      }
    }
    if (changed && frozenEstimateRef.current === null && measuredCountRef.current >= ESTIMATE_FREEZE_AFTER) {
      frozenEstimateRef.current = measuredSumRef.current / measuredCountRef.current;
    }
    if (changed) {
      if (performance.now() - lastWheelAtRef.current > WHEEL_FRESHNESS_MS) {
        setCanvasFrozen(true); // drag/key-scroll in progress — defer the extent change
      }
      setMeasureVersion((version) => version + 1);
    }
  });

  // Content loads jump immediately; the frozen extent is only for quiet drags.
  useEffect(() => {
    setCanvasFrozen(false);
  }, [items]);

  // Commit the live total while unfrozen (the frozen copy is what a drag pins).
  useLayoutEffect(() => {
    if (!canvasFrozen) {
      frozenTotalRef.current = totalHeight;
    }
  }, [totalHeight, canvasFrozen]);

  // Prepend anchor: the offset inside the CURRENT first item is captured while it
  // is first; when the first key changes but stays in the list, the viewport is
  // re-anchored onto it for a few layout passes (estimates settle into measured
  // heights asynchronously — a single restore would drift by their delta).
  const prevFirstKeyRef = useRef<string | null>(null);
  const anchorOffsetInFirstRef = useRef(0);
  const pendingAnchorRef = useRef<{ key: string; offsetInItem: number; passes: number } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null || items.length === 0) {
      return;
    }
    const firstKey = itemKey(items[0]!);
    const previousFirstKey = prevFirstKeyRef.current;
    if (previousFirstKey !== null && previousFirstKey !== firstKey) {
      pendingAnchorRef.current = { key: previousFirstKey, offsetInItem: Math.max(0, anchorOffsetInFirstRef.current), passes: 0 };
    }
    anchorOffsetInFirstRef.current = container.scrollTop - offsets[0]!;
    prevFirstKeyRef.current = firstKey;

    const pending = pendingAnchorRef.current;
    if (pending !== null) {
      const restoreIndex = keyToIndex.get(pending.key);
      if (restoreIndex === undefined) {
        pendingAnchorRef.current = null; // the anchor left the list (channel switch) — drop it
      } else {
        container.scrollTop = offsets[restoreIndex]! + pending.offsetInItem;
        setScrollTop(container.scrollTop);
        pending.passes += 1;
        if (pending.passes >= 3) {
          pendingAnchorRef.current = null;
        }
      }
    }
  });

  useImperativeHandle(ref, () => ({
    scrollToKey(key: string, align: "start" | "center" = "start"): boolean {
      const container = containerRef.current;
      const index = keyToIndex.get(key);
      if (container === null || index === undefined) {
        return false;
      }
      container.scrollTop = align === "center"
        ? offsetForIndexAlignCenter(offsets, index, viewportHeight)
        : Math.max(0, offsetForIndexAlignStart(offsets, index) - 12);
      setScrollTop(container.scrollTop);
      return true;
    },
    scrollTop(): number {
      return containerRef.current?.scrollTop ?? 0;
    },
    viewportHeight(): number {
      return containerRef.current?.clientHeight ?? 0;
    },
    scrollToBottom(): void {
      const container = containerRef.current;
      if (container !== null) {
        container.scrollTop = container.scrollHeight;
        setScrollTop(container.scrollTop);
      }
    },
  }), [keyToIndex, offsets, viewportHeight]);

  const onScroll = () => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    setScrollTop(container.scrollTop);
    virtualScrollTelemetry.scrollTop = container.scrollTop;
    virtualScrollTelemetry.scrollHeight = container.scrollHeight;
    virtualScrollTelemetry.viewportHeight = container.clientHeight;
    virtualScrollTelemetry.thumbFraction = container.scrollHeight - container.clientHeight > 0
      ? container.scrollTop / (container.scrollHeight - container.clientHeight)
      : 0;
    // Drag-stop detector: 150ms of scroll silence = the drag is over → land the
    // deferred extent refinements as one visible thumb jump.
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setCanvasFrozen(false);
    }, SCROLL_IDLE_MS);
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    onBottomProximity?.(distanceFromBottom < NEAR_BOTTOM_THRESHOLD);
    if (container.scrollTop < NEAR_TOP_THRESHOLD && container.scrollHeight > container.clientHeight + 100) {
      onNearTop?.();
    }
  };

  // Viewport size tracking (window resizes change the visible window).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewportHeight(container.clientHeight);
    });
    observer.observe(container);
    setViewportHeight(container.clientHeight);
    return () => observer.disconnect();
  }, []);

  // CANVAS + ABSOLUTE ROWS (react-window style): growing/shrinking spacers mutate the
  // scrollable layout on EVERY scroll frame, which makes Chromium downgrade a native
  // scrollbar-thumb drag to relative delta scrolling (thumb visually "freezes" while
  // the content crawls with the cursor). With a fixed-height canvas the scroll extent
  // only changes when measurements land — the thumb keeps its cursor lock.
  return (
    <div
      className={className ?? "virtual-list"}
      ref={containerRef}
      onScroll={onScroll}
      onWheel={() => {
        lastWheelAtRef.current = performance.now();
      }}
    >
      <div style={{ height: canvasFrozen ? frozenTotalRef.current : totalHeight, position: "relative" }}>
        {items.slice(windowRange.startIndex, windowRange.endIndex + 1).map((item, sliceIndex) => {
          const key = itemKey(item);
          const index = windowRange.startIndex + sliceIndex;
          return (
            <div key={key} data-vkey={key} style={{ position: "absolute", top: offsets[index] ?? 0, left: 0, right: 0 }}>
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
