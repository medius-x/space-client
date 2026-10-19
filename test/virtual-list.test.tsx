// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { VirtualList } from "../src/renderer/components/VirtualList";

// Component-level contract of the rAF-coalesced scroll path: one callback batch
// per animation frame (not per event), paced near-top attempts, the direct
// classList pointer block, and the synchronous wheel arm. jsdom has no layout:
// scrollTop is a plain settable property, clientHeight reads 0, and rAF is
// stubbed with a manual queue flushed by hand — the pacing semantics live in
// scroll-gating.test.ts; this file proves VirtualList WIRES them.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = Array.from({ length: 200 }, (_unused, index) => index + 1);
const ROW_HEIGHT = 50; // flat estimate → totalSize 10_000

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];
const animationFrameQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    animationFrameQueue.push(callback);
    return animationFrameQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (_handle: number): void => undefined);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  animationFrameQueue.length = 0;
});

function flushAnimationFrames(): void {
  const pending = animationFrameQueue.splice(0);
  for (const callback of pending) {
    callback(performance.now());
  }
}

function mountList(callbacks: {
  onNearTop?: () => void;
  onBottomProximity?: (nearBottom: boolean) => void;
} = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <VirtualList
        items={ITEMS}
        itemKey={(item) => String(item)}
        estimateHeight={() => ROW_HEIGHT}
        renderItem={(item) => <div>row {item}</div>}
        onNearTop={callbacks.onNearTop}
        onBottomProximity={callbacks.onBottomProximity}
      />,
    );
  });
  const container = host.querySelector(".virtual-list");
  if (!(container instanceof HTMLElement)) {
    throw new Error("virtual list container not mounted");
  }
  return container;
}

function dispatchScroll(container: HTMLElement, scrollTop: number): void {
  act(() => {
    container.scrollTop = scrollTop;
    container.dispatchEvent(new Event("scroll"));
  });
}

describe("VirtualList scroll coalescing (rAF batch per frame)", () => {
  it("a burst of events fires the callbacks at most once per frame", () => {
    const onNearTop = vi.fn();
    const container = mountList({ onNearTop });
    dispatchScroll(container, 100);
    dispatchScroll(container, 150);
    dispatchScroll(container, 200);
    dispatchScroll(container, 250);
    dispatchScroll(container, 300);
    expect(onNearTop).not.toHaveBeenCalled(); // nothing before a frame
    act(() => flushAnimationFrames());
    expect(onNearTop).toHaveBeenCalledTimes(1);
  });

  it("paces near-top attempts: a second burst inside the interval stays silent", () => {
    const onNearTop = vi.fn();
    const container = mountList({ onNearTop });
    dispatchScroll(container, 100);
    act(() => flushAnimationFrames());
    expect(onNearTop).toHaveBeenCalledTimes(1);
    dispatchScroll(container, 200);
    act(() => flushAnimationFrames());
    expect(onNearTop).toHaveBeenCalledTimes(1); // <250 ms since the attempt
  });

  it("bottom proximity fires on the transition, not on every event", () => {
    const onBottomProximity = vi.fn();
    const container = mountList({ onBottomProximity });
    dispatchScroll(container, 9950);
    act(() => flushAnimationFrames());
    expect(onBottomProximity).toHaveBeenCalledTimes(1);
    expect(onBottomProximity).toHaveBeenCalledWith(true);
    dispatchScroll(container, 9940);
    act(() => flushAnimationFrames());
    dispatchScroll(container, 9960);
    act(() => flushAnimationFrames());
    expect(onBottomProximity).toHaveBeenCalledTimes(1); // pinned, re-assert not due
  });

  it("toggles the .scrolling class per frame and lifts it after idle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = mountList();
    dispatchScroll(container, 1000);
    expect(container.classList.contains("scrolling")).toBe(false); // nothing before a frame
    act(() => flushAnimationFrames());
    expect(container.classList.contains("scrolling")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(container.classList.contains("scrolling")).toBe(false);
  });

  it("the wheel tick arms the pointer block without waiting for a frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = mountList();
    act(() => {
      container.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    expect(container.classList.contains("scrolling")).toBe(true);
  });
});
