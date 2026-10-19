import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSession, type SessionHooks } from "../src/domain/session/connection-session";
import { ConnectionDirectory } from "../src/domain/session/connection-record";
import type { Message } from "../src/types";

function message(id: number, channelId = 1): Message {
  return {
    id,
    channelId,
    authorId: id,
    authorUsername: "alice",
    content: `m${id}`,
    createdAt: new Date(id * 1000).toISOString(),
    attachments: [],
    mentions: [],
    editedAt: null,
    reactions: [],
    reply: null,
    forward: null,
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
    sticker: null,
  };
}

/** Full downward page of NEWER_PAGE (50) messages right after `afterId`. */
function fullPageAfter(afterId: number): Message[] {
  return Array.from({ length: 50 }, (_, index) => message(afterId + 1 + index));
}

function makeSession(fetchImpl: typeof fetch): ConnectionSession {
  const hooks = {
    onSessionExpired: vi.fn(),
    onStompState: vi.fn(),
    onStompConnected: vi.fn(),
    onChannelGone: vi.fn(),
    onChannelsChanged: vi.fn(),
    onLiveMessage: vi.fn(),
    onOwnVoiceControlState: vi.fn(),
    onVoiceKicked: vi.fn(),
    onCallSignal: vi.fn(),
    onDmClosed: vi.fn(),
    onMemberKicked: vi.fn(),
    onOwnershipEvent: vi.fn(),
  } satisfies SessionHooks;
  return new ConnectionSession({
    directory: new ConnectionDirectory(),
    recordId: "test-record",
    hooks,
    fetchImpl,
  });
}

/** A fetch implementation that answers /messages pages from a per-afterId script:
 *  every unscripted afterId yields a FULL page (an endless history below). */
function scriptedFetch(script: Map<number, Message[]>, onRequest?: (afterId: number) => void): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://test");
    if (!url.pathname.endsWith("/messages")) {
      return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    const afterId = Number(url.searchParams.get("afterId") ?? "0");
    onRequest?.(afterId);
    const page = script.get(afterId) ?? fullPageAfter(afterId);
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}

describe("around window auto catch-up (bug 10: messages vanished after a search/pin jump)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a live drop below the window arms the catch-up: pages close the gap, the flag clears, live appends resume", async () => {
    // Window [10..12]; the gap holds 13..62 (one full page) then a SHORT page 63..70.
    const script = new Map<number, Message[]>([
      [12, [...fullPageAfter(12)]],
      [62, Array.from({ length: 8 }, (_, index) => message(63 + index))],
    ]);
    const session = makeSession(scriptedFetch(script));
    session.messageStore.applySnapshotAround(1, [message(10), message(11), message(12)]);

    // Live traffic falls into the gap — dropped, counted, and the trigger.
    expect(session.messageStore.applyLive(message(50, 1))).toBe(false);
    expect(session.messageStore.aroundDropCount(1)).toBe(1);
    session.scheduleAroundCatchUp(1);
    await vi.advanceTimersByTimeAsync(800);

    expect(session.messageStore.isAroundWithoutTail(1)).toBe(false); // healed
    expect(session.messageStore.listFor(1).at(-1)?.id).toBe(70); // gap paginated through
    expect(session.messageStore.aroundDropCount(1)).toBe(0);
    expect(session.messageStore.applyLive(message(71, 1))).toBe(true); // live appends legal again
  });

  it("a hole deeper than the page cap stops at the cap; the next dropped message re-arms", async () => {
    const requests: number[] = [];
    const session = makeSession(scriptedFetch(new Map(), (afterId) => requests.push(afterId)));
    session.messageStore.applySnapshotAround(1, [message(10), message(12)]);

    session.scheduleAroundCatchUp(1);
    await vi.advanceTimersByTimeAsync(1500);
    // 6 pages of 50 = the per-trigger budget, all sequential (each afterId is the previous tail).
    expect(requests).toEqual([12, 62, 112, 162, 212, 262]);
    expect(session.messageStore.isAroundWithoutTail(1)).toBe(true); // hole deeper than the cap
    expect(session.messageStore.listFor(1).at(-1)?.id).toBe(312);

    session.messageStore.applyLive(message(500, 1)); // the pill shows "1 new"
    session.scheduleAroundCatchUp(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toHaveLength(12); // re-armed: another budget spent
    expect(session.messageStore.listFor(1).at(-1)?.id).toBe(612);
  });

  it("the catch-up does not fire for a channel that is no longer in the around state", async () => {
    const requests: number[] = [];
    const session = makeSession(scriptedFetch(new Map(), (afterId) => requests.push(afterId)));
    session.messageStore.applySnapshotAround(1, [message(10), message(12)]);
    session.messageStore.markTailReached(1); // healed by scrolling before the debounce fires

    session.scheduleAroundCatchUp(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toEqual([]); // nothing to close — no REST traffic
  });

  it("dispose() cancels an armed catch-up timer", async () => {
    const requests: number[] = [];
    const session = makeSession(scriptedFetch(new Map(), (afterId) => requests.push(afterId)));
    session.messageStore.applySnapshotAround(1, [message(10), message(12)]);

    session.scheduleAroundCatchUp(1);
    session.dispose();
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toEqual([]);
  });
});
