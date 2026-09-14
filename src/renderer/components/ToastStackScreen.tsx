import { useEffect, useRef, useState } from "react";
import { log } from "../../logging";
import type { ToastCardPayload } from "../bridges";

/**
 * The always-on-top TOAST WINDOW's content (oak's NotificationToast, route
 * #toasts): the card stack + the "Hide all" chip, TTL'd, trimmed to maxToasts.
 * The window is click-through everywhere except actual content — mousemove
 * hit-testing reports hover to main, which flips setIgnoreMouseEvents; clicks
 * travel back to the MAIN window renderer by card id (the callbacks live there,
 * closed over the runtime). Geometry is reported so main can resize the window
 * with the BOTTOM-RIGHT corner anchored.
 *
 * The TTL pauses while the cursor rests ON a card (oak's timer.pause on
 * mouseEntered) and resumes with the REMAINING time on leave — a card must not
 * vanish under the pointer the user is trying to click.
 */

interface ActiveCard {
  id: number;
  title: string;
  channelName: string;
  body: string;
  /** Pre-split body (message toasts): mention spans tint, plain text doesn't. */
  segments: { text: string; mention: boolean }[] | null;
  mention: boolean;
  /** Epoch ms when the card expires; the timer is (re)armed against this. */
  expiresAt: number;
}

export function ToastStackScreen(): React.JSX.Element {
  const [cards, setCards] = useState<ActiveCard[]>([]);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(false);
  /** Card id → its live timeout handle (a paused card has no entry). */
  const timersRef = useRef(new Map<number, number>());
  // The live list for event handlers (they must not close over render-time arrays).
  const cardsRef = useRef<ActiveCard[]>([]);
  cardsRef.current = cards;

  // The window must be a transparent overlay — global.css paints body dark for
  // the MAIN window; without this the toast window is an opaque rectangle over
  // whatever is beneath (live report: "the toasts got a black background").
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  /** Dismiss by id — the shared exit for the timer, the click and the trim. */
  const dismissCard = (cardId: number): void => {
    const timerId = timersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timersRef.current.delete(cardId);
    }
    setCards((current) => {
      const next = current.filter((card) => card.id !== cardId);
      if (next.length === 0) {
        window.spaceToast?.empty();
      }
      return next;
    });
  };

  /** (Re)arm a card's dismiss timer with the given delay (0 = dismiss now). */
  const armCardTimer = (cardId: number, delayMs: number): void => {
    const timerId = timersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
    timersRef.current.set(cardId, window.setTimeout(() => dismissCard(cardId), Math.max(0, delayMs)));
  };

  const pauseCard = (cardId: number): void => {
    const timerId = timersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timersRef.current.delete(cardId);
    }
  };

  /** Resumes every paused card with its remaining time (the cursor left the
   *  window while resting on one — no mouseleave fires through the void). */
  const resumePausedCards = (): void => {
    const now = Date.now();
    for (const card of cardsRef.current) {
      if (!timersRef.current.has(card.id)) {
        armCardTimer(card.id, card.expiresAt - now);
      }
    }
  };

  // Card clicks land here and route to the MAIN window by id.
  useEffect(() => {
    const toastBridge = window.spaceToast;
    if (toastBridge === undefined) {
      return;
    }
    toastBridge.onShow((payload: ToastCardPayload) => {
      log.info("toast", `show id=${payload.id} mention=${payload.mention}`);
      setCards((current) => {
        const next = [...current, {
          id: payload.id,
          title: payload.title,
          channelName: payload.channelName,
          body: payload.body,
          segments: payload.segments ?? null,
          mention: payload.mention,
          expiresAt: Date.now() + Math.max(1, payload.dismissSeconds) * 1000,
        }];
        // Newest on top (Discord): the trim drops the OLDEST cards.
        return next.slice(Math.max(0, next.length - payload.maxToasts));
      });
      armCardTimer(payload.id, Math.max(1, payload.dismissSeconds) * 1000);
    });
    // Click-through toggling: while the window ignores mouse events, moves are
    // still FORWARDED to it — hit-test the target and report interactivity.
    const onMouseMove = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const overContent = target !== null && target.closest(".toast-card, .toast-hide-all") !== null;
      if (overContent !== interactiveRef.current) {
        interactiveRef.current = overContent;
        toastBridge.hover(overContent);
      }
    };
    const onMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null && interactiveRef.current) {
        interactiveRef.current = false;
        toastBridge.hover(false);
        resumePausedCards();
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseout", onMouseOut);
    // The subscription is up — main flushes whatever arrived while the page
    // was still loading (the very first toast would otherwise be lost).
    toastBridge.ready();
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseout", onMouseOut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report the real rendered height (bottom-right anchored resize in main).
  // The stack sits 8px above the window's bottom edge and needs 8px of headroom
  // — reporting the bare content height shifted the whole stack up and clipped
  // the chip (live report). `empty` fires only on the TRANSITION to empty: the
  // mount-time pass with zero cards used to hide the freshly shown window and
  // swallow the first toast until a second one re-showed it (live report).
  const seenCardsRef = useRef(false);
  useEffect(() => {
    const measured = stackRef.current?.offsetHeight ?? 0;
    if (measured > 0) {
      window.spaceToast?.geometry(measured + 16);
    }
    if (cards.length === 0 && seenCardsRef.current) {
      window.spaceToast?.empty();
    }
    seenCardsRef.current = cards.length > 0;
  }, [cards]);

  return (
    <div ref={stackRef} className="toast-stack">
      {cards.length > 0 ? (
        <button
          className="toast-hide-all"
          onClick={() => {
            log.info("toast", "hide-all clicked");
            for (const timerId of timersRef.current.values()) {
              window.clearTimeout(timerId);
            }
            timersRef.current.clear();
            setCards([]);
            window.spaceToast?.empty();
          }}
        >
          Hide all
        </button>
      ) : null}
      {cards.map((card) => (
        <div
          key={card.id}
          className={"toast-card" + (card.mention ? " mention" : "")}
          onMouseEnter={() => pauseCard(card.id)}
          onMouseLeave={() => armCardTimer(card.id, card.expiresAt - Date.now())}
          onClick={() => {
            log.info("toast", `card ${card.id} clicked`);
            window.spaceToast?.clicked(card.id);
            dismissCard(card.id);
          }}
        >
          {card.channelName !== "" ? <div className="toast-header">{card.channelName}</div> : null}
          <div className="toast-author">{card.title}</div>
          <div className="toast-body">
            {card.segments !== null
              ? card.segments.map((segment, segmentIndex) =>
                segment.mention
                  ? <span key={segmentIndex} className="toast-mention">{segment.text}</span>
                  : <span key={segmentIndex}>{segment.text}</span>)
              : card.body}
          </div>
        </div>
      ))}
    </div>
  );
}
