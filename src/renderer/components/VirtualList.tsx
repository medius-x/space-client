import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { virtualScrollTelemetry } from "../scroll-telemetry";
import { ScrollSignalGate } from "../../domain/logic/scroll-gating";
import { log } from "../../logging";

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
/** Idle-timer reschedule floor: within one burst the quiet timer is re-armed
 *  at most this often instead of on every event (see scroll-gating.ts — with
 *  SCROLL_IDLE_MS = 150 the timer always expires ≥100 ms past the last
 *  reschedule, so any burst with events ≥1 per floor stays armed). */
const RESCHEDULE_FLOOR_MS = 50;
/** Pacing for the proximity callbacks (the pure gate owns the semantics). */
const NEAR_TOP_MIN_INTERVAL_MS = 250;
const BOTTOM_REASSERT_MS = 250;

interface VirtualListProps<Item> {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  estimateHeight: (item: Item) => number;
  renderItem: (item: Item, index: number) => React.ReactNode;
  /** Fires while the viewport sits within NEAR_TOP_THRESHOLD of the top. */
  onNearTop?: () => void;
  /** Bottom-proximity signal for the caller's stick-to-bottom logic. */
  onBottomProximity?: (nearBottom: boolean) => void;
  /** Synchronous USER intent: wheel/keys, before any scroll event lands. The
   *  caller's stick-to-bottom must un-pin on the FIRST notch upward — the
   *  proximity gate only reports one rAF later (paced 250 ms), and a batch
   *  arriving inside that window yanked the departing reader back down (the
   *  "scroll away from the bottom bounces back" live report, 2026-10-19). */
  onUserScrollIntent?: (direction: "up" | "down") => void;
  className?: string;
  ref?: React.Ref<VirtualListHandle>;
}

export function VirtualList<Item>(props: VirtualListProps<Item>): React.JSX.Element {
  const { items, itemKey, estimateHeight, renderItem, onNearTop, onBottomProximity, onUserScrollIntent, className, ref } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  // The proximity callbacks live in refs (assigned during render — idempotent
  // under StrictMode's double render): the scroll path never holds a stale
  // closure, and a NEW callback identity no longer re-schedules anything.
  const onNearTopRef = useRef(onNearTop);
  onNearTopRef.current = onNearTop;
  const onBottomProximityRef = useRef(onBottomProximity);
  onBottomProximityRef.current = onBottomProximity;
  const onUserScrollIntentRef = useRef(onUserScrollIntent);
  onUserScrollIntentRef.current = onUserScrollIntent;
  const gate = useMemo(
    () => new ScrollSignalGate({
      nearTopThreshold: NEAR_TOP_THRESHOLD,
      nearBottomThreshold: NEAR_BOTTOM_THRESHOLD,
      bottomReassertMs: BOTTOM_REASSERT_MS,
      nearTopMinIntervalMs: NEAR_TOP_MIN_INTERVAL_MS,
    }),
    [],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index: number) => estimateHeight(items[index]!),
    overscan: OVERSCAN,
    getItemKey: (index: number) => itemKey(items[index]!),
  });

  // First-measure drift diagnostics (2026-10-19, the "thumb bounces through
  // heavy images" report): the engine compensates scrollTop by
  // (measured − estimated) on a row's FIRST measure above the fold, so a
  // systematic estimate error is exactly what the user feels as the scrollbar
  // jerking. This names the offending rows in space.log (paced) instead of
  // guessing which class of rows is off. The wrapper must stay IDENTITY-STABLE
  // (an inline closure would re-fire React refs on every render); the items
  // and the estimator ride through refs.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const estimateRef = useRef(estimateHeight);
  estimateRef.current = estimateHeight;
  // The virtualizer instance is re-created per render by useVirtualizer; the
  // stable row callback below must reach the CURRENT one, never the first.
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const measuredDriftKeysRef = useRef<Set<string>>(new Set());
  const lastDriftLogAtRef = useRef(0);
  const rowRef = useCallback((element: HTMLDivElement | null) => {
    if (element !== null) {
      const rowKey = element.getAttribute("data-vkey");
      if (rowKey !== null && !measuredDriftKeysRef.current.has(rowKey)) {
        measuredDriftKeysRef.current.add(rowKey);
        if (measuredDriftKeysRef.current.size > 5000) {
          measuredDriftKeysRef.current.clear(); // diagnostics only — never a leak
        }
        const index = Number(element.getAttribute("data-index") ?? "-1");
        const currentItems = itemsRef.current;
        const row = index >= 0 && index < currentItems.length ? currentItems[index] : undefined;
        if (row !== undefined) {
          const estimate = estimateRef.current(row);
          const actual = element.getBoundingClientRect().height;
          const now = performance.now();
          if (Math.abs(actual - estimate) > 40 && now - lastDriftLogAtRef.current > 2000) {
            lastDriftLogAtRef.current = now;
            // Full context dump: the estimate/actual pair alone cannot say
            // WHICH input lied — the message's shape (text length, every
            // attachment's type/wire-dims/url presence) plus the list position
            // pin the offender class in ONE reproduction.
            const rowMessage = row as unknown as { content: string | null; attachments: { fileName: string; width: number | null; height: number | null; url: string | null }[] };
            const attachmentDump = rowMessage.attachments
              .map((attachment) => `${attachment.fileName}:${attachment.width ?? "?"}x${attachment.height ?? "?"}${attachment.url === null ? ",no-url" : ""}`)
              .join(" | ");
            log.warn("vscroll", `first-measure drift ${Math.round(actual - estimate)}px (estimate ${Math.round(estimate)}, actual ${Math.round(actual)}) row ${rowKey} index ${index}/${currentItems.length} content ${rowMessage.content === null ? -1 : rowMessage.content.length} attachments [${attachmentDump}]`);
          }
        }
      }
    }
    virtualizerRef.current.measureElement(element);
  }, []);

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
  // SCROLL_IDLE_MS of quiet. The class is toggled DIRECTLY on the DOM node —
  // the old useState round-trip re-rendered the whole list wrapper twice per
  // burst, and a React-managed conditional className would fight the manual
  // toggle (a CONSTANT prop is never rewritten by React, so the class sticks).
  const lastRescheduleRef = useRef(0);
  const armScrollingNow = () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    } else {
      containerRef.current?.classList.add("scrolling");
    }
    lastRescheduleRef.current = performance.now();
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      containerRef.current?.classList.remove("scrolling");
    }, SCROLL_IDLE_MS);
  };
  /** Re-arm at most every RESCHEDULE_FLOOR_MS within a burst; the first arm
   *  (timer idle → class on) is always immediate — the wheel path's instant
   *  contract below depends on it. */
  const maybeArmScrolling = () => {
    if (scrollIdleTimerRef.current !== null
      && performance.now() - lastRescheduleRef.current < RESCHEDULE_FLOOR_MS) {
      return;
    }
    armScrollingNow();
  };

  // The WHEEL tick arms the block INSTANTLY — scroll events alone were too late
  // at an intermittent pace (tick… >150ms pause… tick): the block lifted between
  // ticks and rows swept under the cursor flipped hover states again (perf log:
  // pointerover bursts at 104-216ms inside big groups, live report). Synchronous
  // on purpose: the rAF coalescer below would already be one frame late.
  const onWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    armScrollingNow();
    if (event.deltaY < 0) {
      onUserScrollIntentRef.current?.("up");
    }
  };

  // Keyboard departures from the bottom carry no wheel event — the same
  // instant un-pin for the arrow/page/home keys.
  const onKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
      onUserScrollIntentRef.current?.("up");
    }
  };

  // Geometry for the proximity callbacks comes from the engine's caches (JS
  // state) — no scrollHeight reads that would force a layout flush. The only
  // DOM reads (clientHeight) are valid-layout reads at flush time. The whole
  // handler body runs ONCE PER FRAME (a native scroll burst fires up to ~1 kHz
  // in pixel mode) and the gate paces the callbacks (see scroll-gating.ts).
  const rafRef = useRef<number | null>(null);
  const onScroll = () => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
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
      const decisions = gate.onNext({ scrollTop, totalSize: total, viewportHeight: viewport }, performance.now());
      if (decisions.fireBottomProximity) {
        onBottomProximityRef.current?.(decisions.bottomProximity);
      }
      if (decisions.fireNearTop) {
        onNearTopRef.current?.();
      }
      maybeArmScrolling();
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
    };
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className={className ?? "virtual-list"}
      ref={containerRef}
      onScroll={onScroll}
      onWheelCapture={onWheelCapture}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            data-vkey={virtualRow.key}
            ref={rowRef}
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
