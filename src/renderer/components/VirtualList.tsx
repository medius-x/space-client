import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { virtualScrollTelemetry } from "../scroll-telemetry";

/**
 * Virtualized list over @tanstack/react-virtual (the industry-standard headless
 * engine) — migrated off the hand-rolled window math after a run of scroll-jank
 * regressions. The public API is unchanged: variable heights start from an
 * estimate and are measured by the engine (measureElement), and a PREPEND
 * re-anchors the scroll onto the OLD FIRST ITEM so back-filled history never
 * jumps the viewport. Rows ignore the pointer while scrolling is active —
 * rows sweeping under a still cursor flip hover states dozens of times per
 * second (pure wasted paint during a fling).
 */
export interface VirtualListHandle {
  scrollToKey(key: string, align?: "start" | "center"): boolean;
  scrollTop(): number;
  viewportHeight(): number;
  scrollToBottom(): void;
}

// PREFETCH: history loads while the top is still ~3-4 screens away — the page
// (group-aligned by the caller) lands far above the viewport, so the prepend
// and its scroll compensation NEVER happen under the reader's eyes (the residual
// "kick" on back-fill, live report). 80px loaded right at the edge instead.
export const NEAR_TOP_THRESHOLD = 2500;
export const NEAR_BOTTOM_THRESHOLD = 80;

// Chat rows are SHORT (a continuation line is ~22px), so an overscan counted in
// rows must be generous in rows to be meaningful in pixels: 6 was ~130px of
// runway and every wheel tick mounted rows on the fly (the residual stickiness
// inside big single-author groups — short rows churn the window fastest).
const OVERSCAN = 14;
/** Scroll silence that lifts the pointer-events block (.scrolling). */
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
  const [scrolling, setScrolling] = useState(false);
  const scrollIdleTimerRef = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index: number) => estimateHeight(items[index]!),
    overscan: OVERSCAN,
    getItemKey: (index: number) => itemKey(items[index]!),
  });

  // ---------------------------------------------------------------------------
  // Prepend anchor, ADDITIVE: native scroll anchoring never fires for this list
  // (absolutely-positioned rows moved by transform are invisible to it), so the
  // viewport must be compensated by hand when history is prepended above it.
  // The compensation is a DELTA — how much the OLD first item moved DOWN across
  // the prepend — not an absolute target: an absolute target read from the
  // engine's not-yet-refreshed measurement cache produced ~0 and THREW the
  // viewport to the top of the freshly loaded group (live report). The delta is
  // re-applied on later passes as measurements settle; scrolling by the user
  // never conflicts (a delta of exact content growth keeps the view still).
  // ---------------------------------------------------------------------------
  const lastFirstRef = useRef<{ key: string; start: number } | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null || items.length === 0) {
      lastFirstRef.current = null;
      return;
    }
    const firstKey = itemKey(items[0]!);
    const previous = lastFirstRef.current;
    if (previous !== null && previous.key !== firstKey) {
      const oldIndex = items.findIndex((item) => itemKey(item) === previous.key);
      const oldStartNow = oldIndex === -1 ? undefined : virtualizer.measurementsCache[oldIndex]?.start;
      if (oldStartNow !== undefined) {
        const delta = oldStartNow - previous.start;
        if (Math.abs(delta) > 0.5) {
          container.scrollTop += delta;
        }
      }
    }
    lastFirstRef.current = { key: firstKey, start: virtualizer.measurementsCache[0]?.start ?? 0 };
  });
  // NOTE on resize: do NOT add width-change handling here. The engine's own
  // per-row ResizeObservers + scroll adjustments ride a width change natively
  // (the view stays anchored); the measured-cache-clearing + estimate-based
  // re-anchoring tried here in 2026-09-24 only THREW the viewport — an
  // estimated offset is half the real one on image-heavy chats.

  useImperativeHandle(ref, () => ({
    scrollToKey(key: string, align: "start" | "center" = "start"): boolean {
      const index = items.findIndex((item) => itemKey(item) === key);
      if (index === -1) {
        return false;
      }
      virtualizer.scrollToIndex(index, { align });
      return true;
    },
    scrollTop(): number {
      return containerRef.current?.scrollTop ?? 0;
    },
    viewportHeight(): number {
      return containerRef.current?.clientHeight ?? 0;
    },
    scrollToBottom(): void {
      if (items.length > 0) {
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      }
    },
  }), [items, itemKey, virtualizer]);

  // Rows ignore the pointer while the list is actively scrolling; lifts after
  // SCROLL_IDLE_MS of quiet. Set first, clear once — cheap state churn.
  const armScrolling = () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    } else {
      setScrolling(true);
    }
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setScrolling(false);
    }, SCROLL_IDLE_MS);
  };

  // The WHEEL tick arms the block INSTANTLY — scroll events alone were too late
  // at an intermittent pace (tick… >150ms pause… tick): the block lifted between
  // ticks and rows swept under the cursor flipped hover states again (perf log:
  // pointerover bursts at 104-216ms inside big groups, live report).
  const onWheelCapture = () => {
    armScrolling();
  };

  // Geometry for the proximity callbacks comes from the engine's caches (JS
  // state) — no scrollHeight reads that would force a layout flush per event.
  // The only DOM reads (clientHeight) are valid-layout reads at event time.
  const onScroll = () => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const scrollTop = container.scrollTop;
    const total = virtualizer.getTotalSize();
    const viewport = container.clientHeight;
    virtualScrollTelemetry.scrollTop = scrollTop;
    virtualScrollTelemetry.scrollHeight = total;
    virtualScrollTelemetry.viewportHeight = viewport;
    virtualScrollTelemetry.thumbFraction = total - viewport > 0 ? scrollTop / (total - viewport) : 0;
    onBottomProximity?.(total - scrollTop - viewport < NEAR_BOTTOM_THRESHOLD);
    if (scrollTop < NEAR_TOP_THRESHOLD && total > viewport + 100) {
      onNearTop?.();
    }
    armScrolling();
  };

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
    };
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className={(className ?? "virtual-list") + (scrolling ? " scrolling" : "")}
      ref={containerRef}
      onScroll={onScroll}
      onWheelCapture={onWheelCapture}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              // translateY keeps positioning on the compositor (no layout on reflow).
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderItem(items[virtualRow.index]!, virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
