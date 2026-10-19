/**
 * Pure pacing for the chat scroller's proximity signals (2026-10-19 scroll
 * round). A native scroll event fires up to ~1 kHz in pixel-mode wheeling, and
 * the old VirtualList handler ran per EVENT: proximity callbacks (with their
 * clearTimeout+setTimeout churn) on every event, and the near-top history
 * loader re-arming continuously while the viewport sat in the zone. Consumers
 * only ever needed decisions per FRAME and per INTERACTION CADENCE, so this
 * gate folds the raw stream into two signals:
 *
 *  - fireNearTop: level-triggered (in the zone = the reader wants more
 *    history) but paced to one ATTEMPT per nearTopMinIntervalMs. After a
 *    prepend the compensated scrollTop still lands in the zone and the next
 *    paced attempt fires, so continuous back-fill survives while the per-event
 *    store churn dies.
 *  - fireBottomProximity: EDGE-triggered plus a periodic re-assert while the
 *    viewport STAYS near the bottom. Two live behaviors read repeated true
 *    signals — the around-window downward auto-chain and the divider-dismiss
 *    restart while pinned — and a pure edge would starve both.
 *
 * All timestamps are injected (nowMs) — the gate is testable without timers.
 */
export interface ScrollGeometry {
  scrollTop: number;
  totalSize: number;
  viewportHeight: number;
}

export interface ScrollSignalDecisions {
  /** The current bottom-proximity level (the callback argument). */
  bottomProximity: boolean;
  /** Fire the bottom-proximity callback for this sample (edge or re-assert). */
  fireBottomProximity: boolean;
  /** Fire the near-top callback for this sample (in-zone and paced). */
  fireNearTop: boolean;
}

export interface ScrollGateOptions {
  nearTopThreshold: number;
  nearBottomThreshold: number;
  /** Re-assert cadence for a viewport that STAYS near the bottom. */
  bottomReassertMs: number;
  /** Minimum spacing between near-top ATTEMPTS (not completions). */
  nearTopMinIntervalMs: number;
}

export class ScrollSignalGate {
  private readonly options: ScrollGateOptions;
  private previousBottomProximity = false;
  private lastBottomFireMs = Number.NEGATIVE_INFINITY;
  private lastNearTopAttemptMs = Number.NEGATIVE_INFINITY;

  constructor(options: ScrollGateOptions) {
    this.options = options;
  }

  /** The +100 slack: a list barely taller than the viewport is not paginated
   *  (loading more would only grow an already-fitting view). */
  private inNearTopZone(geometry: ScrollGeometry): boolean {
    return geometry.scrollTop < this.options.nearTopThreshold
      && geometry.totalSize > geometry.viewportHeight + 100;
  }

  onNext(geometry: ScrollGeometry, nowMs: number): ScrollSignalDecisions {
    const nearTopZone = this.inNearTopZone(geometry);
    if (!nearTopZone) {
      // Re-entry fires immediately — the pacer only spaces attempts INSIDE a zone.
      this.lastNearTopAttemptMs = Number.NEGATIVE_INFINITY;
    }
    const fireNearTop = nearTopZone && nowMs - this.lastNearTopAttemptMs >= this.options.nearTopMinIntervalMs;
    if (fireNearTop) {
      this.lastNearTopAttemptMs = nowMs;
    }

    const bottomProximity =
      geometry.totalSize - geometry.scrollTop - geometry.viewportHeight < this.options.nearBottomThreshold;
    const isEdge = bottomProximity !== this.previousBottomProximity;
    const isReassert = bottomProximity && nowMs - this.lastBottomFireMs >= this.options.bottomReassertMs;
    const fireBottomProximity = isEdge || isReassert;
    if (fireBottomProximity) {
      this.lastBottomFireMs = nowMs;
      this.previousBottomProximity = bottomProximity;
    }

    return { bottomProximity, fireBottomProximity, fireNearTop };
  }

  reset(): void {
    this.previousBottomProximity = false;
    this.lastBottomFireMs = Number.NEGATIVE_INFINITY;
    this.lastNearTopAttemptMs = Number.NEGATIVE_INFINITY;
  }
}
