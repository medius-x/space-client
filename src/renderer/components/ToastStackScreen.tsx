import { useEffect, useRef, useState } from "react";
import { log } from "../../logging";
import type { ToastCardPayload, ToastCallCardPayload, ToastShowPayload, ToastVoiceInviteCardPayload } from "../bridges";

/**
 * The always-on-top TOAST WINDOW's content (oak's NotificationToast, route
 * #toasts): the card stack + the "Hide all" chip, TTL'd, trimmed to maxToasts —
 * plus the sticky INCOMING-CALL card (oak's CallOverlay). The window is
 * click-through everywhere except actual content — mousemove hit-testing
 * reports hover to main, which flips setIgnoreMouseEvents; clicks travel back
 * to the MAIN window renderer by card id (the callbacks live there, closed
 * over the runtime). Geometry is reported so main can resize the window with
 * the BOTTOM-RIGHT corner anchored.
 *
 * The TTL pauses while the cursor rests ON a card (oak's timer.pause on
 * mouseEntered) and resumes with the REMAINING time on leave — a card must not
 * vanish under the pointer the user is trying to click.
 *
 * The CALL card outranks toasts (user decision): while it is up the stack
 * drops its cards and refuses new ones — a ringing call is the louder event.
 * It has no TTL; only a "call-end" from the call machine removes it.
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

/** The live incoming-call card — sticky, no timer (the runtime tears it down). */
interface ActiveCallCard extends ToastCallCardPayload {}

/** A live voice-invite card — TTL'd like a message toast, pausing on hover. */
type ActiveVoiceInviteCard = ToastVoiceInviteCardPayload & { expiresAt: number };

export function ToastStackScreen(): React.JSX.Element {
  const [cards, setCards] = useState<ActiveCard[]>([]);
  const [callCard, setCallCard] = useState<ActiveCallCard | null>(null);
  const [voiceInviteCards, setVoiceInviteCards] = useState<ActiveVoiceInviteCard[]>([]);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(false);
  /** Card id → its live timeout handle (a paused card has no entry). */
  const timersRef = useRef(new Map<number, number>());
  /** The invite cards' own timer pool (their ids never collide with toast ids:
   *  the invites come from a separate main-window counter). */
  const inviteTimersRef = useRef(new Map<number, number>());
  // The live lists for event handlers (they must not close over render-time values).
  const cardsRef = useRef<ActiveCard[]>([]);
  cardsRef.current = cards;
  const callCardRef = useRef<ActiveCallCard | null>(null);
  callCardRef.current = callCard;
  const voiceInviteCardsRef = useRef<ActiveVoiceInviteCard[]>([]);
  voiceInviteCardsRef.current = voiceInviteCards;

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
      if (next.length === 0 && callCardRef.current === null) {
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

  /** Removes the call card; an empty window hides (same transition rule as cards). */
  const dismissCallCard = (): void => {
    setCallCard(null);
    if (cardsRef.current.length === 0 && voiceInviteCardsRef.current.length === 0) {
      window.spaceToast?.empty();
    }
  };

  /** Dismiss an invite card by id — the timer, the Join/Dismiss and the TTL's
   *  shared exit. */
  const dismissInviteCard = (cardId: number): void => {
    const timerId = inviteTimersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      inviteTimersRef.current.delete(cardId);
    }
    setVoiceInviteCards((current) => {
      const next = current.filter((card) => card.id !== cardId);
      if (next.length === 0 && cardsRef.current.length === 0 && callCardRef.current === null) {
        window.spaceToast?.empty();
      }
      return next;
    });
  };

  const armInviteCardTimer = (cardId: number, delayMs: number): void => {
    const timerId = inviteTimersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
    inviteTimersRef.current.set(cardId, window.setTimeout(() => dismissInviteCard(cardId), Math.max(0, delayMs)));
  };

  const pauseInviteCard = (cardId: number): void => {
    const timerId = inviteTimersRef.current.get(cardId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      inviteTimersRef.current.delete(cardId);
    }
  };

  /** Resumes invite cards paused by hover (the cursor left the window). */
  const resumePausedInviteCards = (): void => {
    const now = Date.now();
    for (const card of voiceInviteCardsRef.current) {
      if (!inviteTimersRef.current.has(card.id)) {
        armInviteCardTimer(card.id, card.expiresAt - now);
      }
    }
  };

  // Card clicks land here and route to the MAIN window by id; the call card's
  // buttons route as actions (Accept/Decline run in the main renderer's runtime).
  useEffect(() => {
    const toastBridge = window.spaceToast;
    if (toastBridge === undefined) {
      return;
    }
    toastBridge.onShow((payload: ToastShowPayload) => {
      if (payload.kind === "message") {
        if (callCardRef.current !== null) {
          log.info("toast", `show id=${payload.card.id} suppressed — the call card owns the corner`);
          return;
        }
        const card: ToastCardPayload = payload.card;
        log.info("toast", `show id=${card.id} mention=${card.mention}`);
        setCards((current) => {
          const next = [...current, {
            id: card.id,
            title: card.title,
            channelName: card.channelName,
            body: card.body,
            segments: card.segments ?? null,
            mention: card.mention,
            expiresAt: Date.now() + Math.max(1, card.dismissSeconds) * 1000,
          }];
          // Newest on top (Discord): the trim drops the OLDEST cards.
          return next.slice(Math.max(0, next.length - card.maxToasts));
        });
        armCardTimer(card.id, Math.max(1, card.dismissSeconds) * 1000);
        return;
      }
      if (payload.kind === "call") {
        // The call outranks toasts: clear the stack (and its timers) and take
        // the corner. No TTL is armed — only "call-end" removes the card.
        log.info("toast", `call card from ${payload.card.peer}`);
        for (const timerId of timersRef.current.values()) {
          window.clearTimeout(timerId);
        }
        timersRef.current.clear();
        setCards([]);
        setCallCard(payload.card);
        return;
      }
      if (payload.kind === "call-status") {
        setCallCard((current) => current === null ? null : { ...current, status: payload.status });
        return;
      }
      if (payload.kind === "voice-invite") {
        // Stacks WITH the message toasts (a room invite is a nudge, not an
        // event that outranks anything) and TTLs on its own. A REPUBLISH of the
        // same id (the avatar chase repainting the fallback initial) replaces
        // the card in place — appending would show the same invite twice, once
        // with the fallback initial (live report).
        log.info("toast", `voice invite id=${payload.card.id} from ${payload.card.inviterName}`);
        setVoiceInviteCards((current) => {
          const existing = current.find((card) => card.id === payload.card.id) ?? null;
          const expiresAt = existing !== null
            ? existing.expiresAt // a repaint does not extend the TTL
            : Date.now() + payload.card.dismissSeconds * 1000;
          return [...current.filter((card) => card.id !== payload.card.id), { ...payload.card, expiresAt }];
        });
        const liveCard = voiceInviteCardsRef.current.find((card) => card.id === payload.card.id) ?? null;
        if (liveCard !== null) {
          armInviteCardTimer(payload.card.id, liveCard.expiresAt - Date.now());
        } else {
          armInviteCardTimer(payload.card.id, payload.card.dismissSeconds * 1000);
        }
        return;
      }
      if (payload.kind === "voice-invite-end") {
        dismissInviteCard(payload.id);
        return;
      }
      dismissCallCard();
    });
    // Click-through toggling: while the window ignores mouse events, moves are
    // still FORWARDED to it — hit-test the target and report interactivity.
    const onMouseMove = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const overContent = target !== null
        && target.closest(".toast-card, .toast-call-card, .toast-voice-invite-card, .toast-hide-all") !== null;
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
        resumePausedInviteCards();
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
  // the chip (live report). `empty` fires only on the TRANSITION to empty (no
  // cards AND no call card): the mount-time pass with zero cards used to hide
  // the freshly shown window and swallow the first toast until a second one
  // re-showed it (live report).
  const seenContentRef = useRef(false);
  useEffect(() => {
    const measured = stackRef.current?.offsetHeight ?? 0;
    if (measured > 0) {
      window.spaceToast?.geometry(measured + 16);
    }
    if (cards.length === 0 && voiceInviteCards.length === 0 && callCard === null && seenContentRef.current) {
      window.spaceToast?.empty();
    }
    seenContentRef.current = cards.length > 0 || voiceInviteCards.length > 0 || callCard !== null;
  }, [cards, callCard, voiceInviteCards]);

  return (
    <div ref={stackRef} className="toast-stack">
      {callCard !== null ? (
        <div className="toast-call-card">
          {callCard.avatarUrl !== null ? (
            <img className="toast-call-avatar" src={callCard.avatarUrl} alt={callCard.peer} draggable={false} />
          ) : (
            <span
              className="toast-call-avatar toast-call-avatar-initial"
              style={{ backgroundColor: callCard.avatarColor }}
            >
              {/* oak's initials(): the first TWO characters, uppercased ("Al" for "alex"). */}
              {callCard.peer.trim().length === 0 ? "??" : callCard.peer.trim().slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="toast-call-text">
            <span className="toast-call-status">{callCard.status}</span>
            <span className="toast-call-name">{callCard.peer}</span>
            <span className="toast-call-server">{callCard.serverName}</span>
          </div>
          {callCard.status === "Incoming call" ? (
            <div className="toast-call-actions">
              <button
                className="toast-call-accept"
                title="Accept"
                // pointerdown is the rawest hop marker (diagnostic, live
                // 2026-10-15): it fires before click — presence without a
                // following "accept clicked" means the click never assembled.
                onPointerDown={() => log.info("toast", "call button pointerdown")}
                onClick={() => {
                  log.info("toast", "call accept clicked");
                  window.spaceToast?.callAction("accept");
                }}
              >
                <span className="icon mdi-phone" />
              </button>
              <button
                className="toast-call-decline"
                title="Decline"
                onPointerDown={() => log.info("toast", "call button pointerdown")}
                onClick={() => {
                  log.info("toast", "call decline clicked");
                  window.spaceToast?.callAction("decline");
                }}
              >
                <span className="icon mdi-phone-hangup" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {cards.length > 0 && callCard === null ? (
        <button
          className="toast-hide-all"
          onClick={() => {
            log.info("toast", "hide-all clicked");
            for (const timerId of timersRef.current.values()) {
              window.clearTimeout(timerId);
            }
            timersRef.current.clear();
            for (const timerId of inviteTimersRef.current.values()) {
              window.clearTimeout(timerId);
            }
            inviteTimersRef.current.clear();
            setCards([]);
            setVoiceInviteCards([]);
            window.spaceToast?.empty();
          }}
        >
          Hide all
        </button>
      ) : null}
      {voiceInviteCards.map((card) => (
        <div
          key={card.id}
          className="toast-voice-invite-card"
          onMouseEnter={() => pauseInviteCard(card.id)}
          onMouseLeave={() => armInviteCardTimer(card.id, card.expiresAt - Date.now())}
        >
          {card.avatarUrl !== null ? (
            <img className="toast-call-avatar" src={card.avatarUrl} alt={card.inviterName} draggable={false} />
          ) : (
            <span
              className="toast-call-avatar toast-call-avatar-initial"
              style={{ backgroundColor: card.avatarColor }}
            >
              {card.inviterName.trim().length === 0 ? "??" : card.inviterName.trim().slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="toast-call-text">
            <span className="toast-call-status">Voice invite</span>
            <span className="toast-call-name">{card.inviterName}</span>
            <span className="toast-call-server">{card.channelName} · {card.serverName}</span>
          </div>
          <div className="toast-call-actions">
            <button
              className="toast-invite-join"
              title="Join"
              onClick={() => {
                log.info("toast", `voice invite ${card.id} join clicked`);
                window.spaceToast?.voiceInviteAction("join", card.id);
              }}
            >
              <span className="icon mdi-location-enter" />
            </button>
            <button
              className="toast-invite-dismiss"
              title="Dismiss"
              onClick={() => {
                log.info("toast", `voice invite ${card.id} dismissed`);
                window.spaceToast?.voiceInviteAction("dismiss", card.id);
                dismissInviteCard(card.id);
              }}
            >
              <span className="icon mdi-close" />
            </button>
          </div>
        </div>
      ))}
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
