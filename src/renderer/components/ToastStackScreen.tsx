import { useEffect, useRef, useState } from "react";
import type { ToastCardPayload } from "../bridges";

/**
 * The always-on-top TOAST WINDOW's content (oak's NotificationToast, route
 * #toasts): the card stack + the "Hide all" chip, TTL'd, trimmed to maxToasts.
 * The window is click-through everywhere except actual content — mousemove
 * hit-testing reports hover to main, which flips setIgnoreMouseEvents; clicks
 * travel back to the MAIN window renderer by card id (the callbacks live there,
 * closed over the runtime). Geometry is reported so main can resize the window
 * with the BOTTOM-RIGHT corner anchored.
 */

interface ActiveCard {
  id: number;
  title: string;
  channelName: string;
  body: string;
  mention: boolean;
}

export function ToastStackScreen(): React.JSX.Element {
  const [cards, setCards] = useState<ActiveCard[]>([]);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(false);

  // The window must be a transparent overlay — the app's dark body would paint
  // an opaque rectangle over whatever is beneath.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // Card clicks land here and route to the MAIN window by id.
  useEffect(() => {
    const toastBridge = window.spaceToast;
    if (toastBridge === undefined) {
      return;
    }
    const dismiss = (cardId: number): void => {
      setCards((current) => {
        const next = current.filter((card) => card.id !== cardId);
        if (next.length === 0) {
          toastBridge.empty();
        }
        return next;
      });
    };
    toastBridge.onShow((payload) => {
      setCards((current) => {
        const next = [...current, {
          id: payload.id,
          title: payload.title,
          channelName: payload.channelName,
          body: payload.body,
          mention: payload.mention,
        }];
        // Newest on top (Discord): the trim drops the OLDEST cards.
        return next.slice(Math.max(0, next.length - payload.maxToasts));
      });
      window.setTimeout(() => dismiss(payload.id), Math.max(1, payload.dismissSeconds) * 1000);
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
          onClick={() => {
            window.spaceToast?.clicked(card.id);
            setCards((current) => current.filter((entry) => entry.id !== card.id));
          }}
        >
          <div className="toast-header">{card.channelName}</div>
          <div className="toast-author">{card.title}</div>
          <div className="toast-body">{card.body.slice(0, 140)}</div>
        </div>
      ))}
    </div>
  );
}
