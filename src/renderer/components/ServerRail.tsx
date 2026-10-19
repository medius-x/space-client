import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import {
  appStore,
  beginAddServer,
  connectionDirectory,
  exitHomeMode,
  openServerMenu,
  sessionForRecord,
  sessionsIndex,
  settingsStore,
  switchConnection,
  toggleHomeMode,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { ConnectionRecord } from "../../domain/session/connection-record";
import { EXPIRED_MARKER } from "../../domain/session/connection-record";
import { applyRailDrop } from "../../domain/logic/rail-drag";
import type { SocialState } from "../../domain/stores/SocialStore";
import type { UnreadState } from "../../domain/stores/ReadStateStore";
import { paletteColor } from "../../domain/logic/user-palette";
import { serverInitials } from "../../domain/logic/server-initials";
import { socialDirectory } from "../social-aggregate";
import { log } from "../../logging";

/** Stable EMPTY store surrogates for the non-active rows — useStore needs a
 *  live store on every branch (hook rules). */
const EMPTY_READ_STATES: ReadonlyMap<number, UnreadState> = new Map();
const nullReadStateStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): ReadonlyMap<number, UnreadState> => EMPTY_READ_STATES,
};
const EMPTY_SOCIAL: SocialState = { relationships: [], dms: [] };
const nullSocialStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): SocialState => EMPTY_SOCIAL,
};;

/**
 * The Discord-style server rail: the Home button (friends + DMs) on top, then
 * one squircle icon per saved connection — the server's AVATAR when it has
 * one, a palette-colored initials disc otherwise (oak's ServerNode) — then the
 * "+" row. Click switches, right-click opens the server dropdown (restored
 * 2026-09-24 — the same menu as the Sidebar's server-name header), hover shows
 * the name bubble. The per-server menu (settings/re-login/delete) moved to the
 * Sidebar's server-name dropdown (2026-09-21).
 */
export function ServerRail({ activeRecordId, session }: {
  activeRecordId: string | null;
  session: ConnectionSession | null;
}): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const dmMode = useStore(appStore, (state) => state.dmMode);

  // --- Drag-reorder (the Sidebar channel-drag mechanics, third copy) --------
  /** The dragged record id; its row renders as the drop gap. */
  const [draggedId, setDraggedId] = useState<string | null>(null);
  /** Optimistic order while a drag is live; null = the directory's truth. A
   *  dropped drag clears it right away — reorder() applies memory synchronously
   *  (unlike the channel drag, whose server round-trip keeps the preview). */
  const [previewIds, setPreviewIds] = useState<readonly string[] | null>(null);
  /** The press that MIGHT become a drag (movement past the threshold commits it). */
  const dragCandidateRef = useRef<{ recordId: string; startX: number; startY: number } | null>(null);
  /** The floating icon copy — FIXED through a portal (the rail scrolls, and an
   *  absolute child of a scrolling box gets clipped at its edge, rail-bubble
   *  lesson). Rendered by the DRAGGED RailRow, which owns the resolved avatar
   *  URL; positioned imperatively from here. */
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  /** Swallows the CLICK that follows a completed drag (press+release inside the
   *  same 2px-tall gap row can still assemble one) — a jiggle must not switch
   *  the active server. */
  const suppressNextClickRef = useRef(false);

  const viewIds = previewIds ?? records.map((record) => record.id);
  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record] as const)), [records]);

  // Hit-testing rows by pointer geometry (the roles discipline: the CONTAINER is
  // stable while the preview reorders the rows under the cursor). The area above
  // the FIRST server row (Home / separator), the "+" row, and everything
  // horizontally OUTSIDE the rail are not drop zones — a cursor dragged into the
  // chat must not keep reordering the preview (an X bound the Sidebar's channel
  // hit-test lacks; the narrow 72px rail needs it).
  const dropTargetUnderPointer = (clientX: number, clientY: number): { targetId: string | null; below: boolean } | null => {
    const container = railRef.current;
    if (container === null) {
      return null;
    }
    const railRect = container.getBoundingClientRect();
    if (clientX < railRect.left || clientX > railRect.right) {
      return null; // outside the rail horizontally — keep the current preview
    }
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-rail-record-id]"));
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        if (row.dataset.railDragged === "true") {
          return null; // over the gap itself — keep the current preview
        }
        return { targetId: row.dataset.railRecordId ?? null, below: clientY > rect.top + rect.height / 2 };
      }
    }
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    if (lastRow !== undefined && clientY > lastRow.getBoundingClientRect().bottom) {
      return { targetId: null, below: true }; // below every row — append
    }
    return null;
  };

  /** Live-previews the drop; returns the resulting order for the DROP to persist. */
  const previewTowards = (target: { targetId: string | null; below: boolean }): readonly string[] => {
    if (draggedId === null) {
      return previewIds ?? viewIds;
    }
    const next = applyRailDrop(previewIds ?? viewIds, draggedId, target.targetId, target.below);
    setPreviewIds(next); // a no-op returns the same reference — React bails out
    return next;
  };

  useEffect(() => {
    // Re-asserted on every (re)subscribe (the roles lesson: the commit-time class
    // add is wiped by the cleanup of the previous effect run).
    if (draggedId !== null) {
      document.body.classList.add("rail-dragging");
    }
    const onPointerMove = (event: PointerEvent): void => {
      const candidate = dragCandidateRef.current;
      if (candidate === null) {
        return;
      }
      if (draggedId === null) {
        if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) < 4) {
          return; // still a press, not a drag — a click must stay a click
        }
        setDraggedId(candidate.recordId);
        document.body.classList.add("rail-dragging");
      }
      if (ghostRef.current !== null) {
        ghostRef.current.style.transform = `translate(${event.clientX + 12}px, ${event.clientY - 14}px)`;
        ghostRef.current.classList.add("positioned");
      }
      const target = dropTargetUnderPointer(event.clientX, event.clientY);
      if (target !== null) {
        previewTowards(target);
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      const wasDragging = draggedId !== null;
      dragCandidateRef.current = null;
      document.body.classList.remove("rail-dragging");
      if (!wasDragging) {
        return;
      }
      suppressNextClickRef.current = true;
      const target = dropTargetUnderPointer(event.clientX, event.clientY);
      const finalIds = target !== null ? previewTowards(target) : previewIds ?? viewIds;
      const currentIds = records.map((record) => record.id);
      const sameOrder = finalIds.length === currentIds.length
        && finalIds.every((recordId, index) => recordId === currentIds[index]);
      if (!sameOrder) {
        // Memory + emit land synchronously inside reorder(); the durable write is
        // fire-and-forget (SettingsStore.apply discipline — a local KV file, no
        // server round-trip to roll back from).
        void connectionDirectory.reorder(finalIds).catch((reorderError: unknown) => {
          const message = reorderError instanceof Error ? reorderError.message : String(reorderError);
          log.error("rail", `server reorder failed: ${message}`);
        });
      }
      setPreviewIds(null);
      setDraggedId(null); // drop the DRAG (the gap row returns to its icon)
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && draggedId !== null) {
        dragCandidateRef.current = null;
        document.body.classList.remove("rail-dragging");
        setDraggedId(null);
        setPreviewIds(null); // rollback to the directory's truth
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("rail-dragging");
    };
    // records/previewIds are the fallbacks in onPointerUp — a stale closure over
    // an outdated order would persist the OLD layout on a drop with no preview.
  }, [draggedId, records, previewIds]);

  /** The pointer press on a server row (left button; Home and "+" never arm). */
  const onRowPointerDown = (recordId: string) => (event: React.PointerEvent) => {
    if (event.button === 0) {
      suppressNextClickRef.current = false;
      dragCandidateRef.current = { recordId, startX: event.clientX, startY: event.clientY };
    }
  };

  return (
    <nav className="server-rail" ref={railRef}>
      {session !== null ? <HomeRailButton session={session} /> : <DisabledHomeRailButton />}
      <div className="rail-separator" />
      {viewIds.map((recordId) => {
        const record = recordById.get(recordId);
        return record === undefined ? null : (
          <RailRow
            key={record.id}
            record={record}
            active={record.id === activeRecordId && !dmMode}
            expired={record.token === EXPIRED_MARKER}
            session={session}
            dragging={record.id === draggedId}
            ghostRef={ghostRef}
            onDragPointerDown={onRowPointerDown(record.id)}
            onActivate={() => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                return; // the click that follows a completed drag
              }
              if (record.id === activeRecordId) {
                // In Home mode the ACTIVE server icon is the "back to the server"
                // affordance — without this the click hits the same-record guard
                // and does nothing (live M6 smoke).
                exitHomeMode();
                return;
              }
              // NEVER gated: the rail is the primary navigation and a switching
              // attempt in flight must not eat clicks (user decision 2026-10-08) —
              // switchConnection/openSession tolerate the overlap.
              void switchConnection(record.id);
            }}
          />
        );
      })}
      <div className="rail-wrap" title="Add a server" onClick={beginAddServer}>
        <div className="rail-icon add"><span className="icon mdi-plus" /></div>
      </div>
    </nav>
  );
}

/** The live session OWNING a record (active first, then its background twin),
 *  re-resolved whenever the set of live sessions changes — see sessionsIndex. */
function useRecordSession(recordId: string, activeSession: ConnectionSession | null): ConnectionSession | null {
  useStore(sessionsIndex, (version) => version);
  if (activeSession !== null && activeSession.recordId === recordId) {
    return activeSession;
  }
  return sessionForRecord(recordId);
}

/**
 * The server icon at ANY size (the settings preview reuses it): the avatar by
 * stable key (live presigned URL for the active session) or the palette
 * initials disc — squircle-clipped like the rail.
 */
export function ServerIconPreview({ session, size }: {
  session: ConnectionSession;
  size: number;
}): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const record = records.find((entry) => entry.id === session.recordId) ?? null;
  const name = record?.cachedServerName ?? session.hostUrl().replace(/^https?:\/\//, "");
  const liveAvatarUrl = session.serverProfile?.avatarUrl ?? null;
  const iconUrl = useAttachmentImage(
    session,
    record?.cachedServerAvatarKey != null ? { key: record.cachedServerAvatarKey, url: liveAvatarUrl } : null,
  );
  return (
    <span className="rail-preview" style={{ width: size, height: size }}>
      <ServerIconBody iconUrl={iconUrl} name={name} />
    </span>
  );
}

/** The squircle-clipped icon content shared by the rail rows and the preview. */
function ServerIconBody({ iconUrl, name }: { iconUrl: string | null; name: string }): React.JSX.Element {
  return iconUrl !== null ? (
    <img className="rail-avatar" src={iconUrl} alt={name} draggable={false} />
  ) : (
    <span className="rail-avatar rail-avatar-fallback" style={{ background: paletteColor(name) }}>
      {serverInitials(name)}
    </span>
  );
}

/**
 * One server row: the 72×56 click wrap (oak's ServerNode) carrying the white
 * selection pill at the rail's left edge, the 48×48 squircle icon and the
 * unread badge at its bottom-right corner. While DRAGGED, the wrap collapses
 * to the 2px drop gap and the row itself renders the floating ghost (it owns
 * the resolved avatar URL — the parent cannot call the hooks for it).
 */
function RailRow({ record, active, expired, session, dragging, ghostRef, onDragPointerDown, onActivate }: {
  record: ConnectionRecord;
  active: boolean;
  expired: boolean;
  session: ConnectionSession | null;
  dragging: boolean;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  onDragPointerDown(event: React.PointerEvent): void;
  onActivate(): void;
}): React.JSX.Element {
  const name = record.cachedServerName ?? record.hostUrl.replace(/^https?:\/\//, "");
  // Every record resolves its OWN session (the active one or its background
  // twin) — the avatar loads through ITS rest/attachment cache, so a missing
  // disk copy still mints and fetches even with the disk cache OFF; a record
  // with no live session falls back to the dormant disk-only cache.
  const ownSession = useRecordSession(record.id, session);
  const liveAvatarUrl = ownSession?.serverProfile?.avatarUrl ?? null;
  const iconUrl = useAttachmentImage(
    ownSession,
    record.cachedServerAvatarKey !== null ? { key: record.cachedServerAvatarKey, url: liveAvatarUrl } : null,
  );
  const badge = useServerBadge(record.id, session);

  // oak's name bubble: a Discord-style pill to the RIGHT of the icon, vertically
  // centered on it (not at the cursor) — a custom popup, never a native Tooltip.
  // Shows after 400 ms of hover, hides instantly on leave (MainController 8470-8489).
  // PORTED TO document.body: the rail scrolls (overflow-y: auto), which per CSS
  // computes overflow-x to auto too — an absolutely-positioned pill past the
  // 72px rail edge was CLIPPED, so the bubble never appeared (live report).
  const [bubbleAnchor, setBubbleAnchor] = useState<{ top: number; left: number } | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  const iconRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => {
    if (bubbleTimerRef.current !== null) {
      window.clearTimeout(bubbleTimerRef.current);
    }
  }, []);

  return (
    <div
      className={"rail-wrap" + (active ? " active" : "") + (dragging ? " drop-gap" : "")}
      data-rail-record-id={record.id}
      data-rail-dragged={dragging ? "true" : undefined}
      onPointerDown={onDragPointerDown}
      onClick={onActivate}
      onContextMenu={(event) => {
        // The restored pre-2026-09-21 affordance (user request): the SAME server
        // dropdown the Sidebar's header opens, at the cursor, for ANY record —
        // session-bound entries hide themselves for non-active rows.
        event.preventDefault();
        openServerMenu(record.id, event.clientX, event.clientY);
      }}
      onMouseEnter={() => {
        if (document.body.classList.contains("rail-dragging")) {
          return; // no name bubbles mid-drag — the drag owns the pointer
        }
        if (bubbleTimerRef.current !== null) {
          window.clearTimeout(bubbleTimerRef.current);
        }
        bubbleTimerRef.current = window.setTimeout(() => {
          const rect = iconRef.current?.getBoundingClientRect();
          if (rect !== undefined) {
            setBubbleAnchor({ top: rect.top + rect.height / 2, left: rect.right + 4 });
          }
        }, 400);
      }}
      onMouseLeave={() => {
        if (bubbleTimerRef.current !== null) {
          window.clearTimeout(bubbleTimerRef.current);
          bubbleTimerRef.current = null;
        }
        setBubbleAnchor(null);
      }}
    >
      {active ? <span className="rail-pill" /> : null}
      <div ref={iconRef} className={"rail-icon" + (expired ? " expired" : "")}>
        <ServerIconBody iconUrl={iconUrl} name={name} />
      </div>
      {/* A SIBLING of the icon, like the Home badge: inside .rail-icon the
          squircle clip-path would cut it (live report). */}
      {badge !== null ? (
        <span className={"rail-badge" + (badge.mention > 0 ? "" : " plain")}>
          {badge.unread > 99 ? "99+" : badge.unread}
        </span>
      ) : null}
      {bubbleAnchor !== null
        ? createPortal(
          <span className="rail-name-bubble" style={{ top: bubbleAnchor.top, left: bubbleAnchor.left }}>
            {name}
          </span>,
          document.body,
        )
        : null}
      {dragging
        ? createPortal(
          <div ref={ghostRef} className="rail-drag-ghost">
            <ServerIconBody iconUrl={iconUrl} name={name} />
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

/**
 * oak's ServerNode unread badge: grey = unread server-channel messages, red =
 * mentioned; shown on EVERY server (the active one included). The ACTIVE
 * instance counts live from its read-state store (DM channels excluded — those
 * feed the Home badge); inactive instances read the snapshot totals, refreshed
 * on switch and on entering the DM view.
 */
function useServerBadge(recordId: string, session: ConnectionSession | null): { unread: number; mention: number } | null {
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const active = session !== null && session.recordId === recordId;
  // Both hooks run unconditionally (hook rules); the active flag picks the winner.
  const liveStates = useStore(active && session !== null ? session.readStateStore : nullReadStateStore, (states) => states);
  const liveDms = useStore(active && session !== null ? session.socialStore : nullSocialStore, (state) => state.dms);
  const background = useStore(socialDirectory, (snapshots) => snapshots);
  if (!badgeEnabled) {
    return null;
  }
  if (active) {
    const dmIds = new Set(liveDms.map((dm) => dm.id));
    let unread = 0;
    let mention = 0;
    for (const [channelId, state] of liveStates) {
      if (!dmIds.has(channelId)) {
        unread += state.unreadCount;
        mention += state.mentionCount;
      }
    }
    return unread > 0 ? { unread, mention } : null;
  }
  const snapshot = background.find((entry) => entry.recordId === recordId) ?? null;
  return snapshot !== null && snapshot.serverCounts.unread > 0 ? snapshot.serverCounts : null;
}

/** The Home placeholder while NO session is live (all servers offline at
 *  startup): Home is the DM view and has nothing to show without a session,
 *  but the button vanishing between offline/online states reads as breakage
 *  (user report 2026-10-08) — it stays in place, inert, with a hint. */
function DisabledHomeRailButton(): React.JSX.Element {
  return (
    <div className="rail-wrap home" title="Connect to a server to open your direct messages">
      <div className="rail-icon home"><img className="rail-logo" src="logo.png" alt="" draggable={false} /></div>
    </div>
  );
}

/** Home button + the DM-unread badge (mounted only while a session is live).
 *  The badge counts the ACTIVE instance's DMs plus every background snapshot's
 *  seeded counts, PLUS the incoming friend requests across instances (user
 *  decision), and hides while the DM view is open (oak's HomeNode). */
function HomeRailButton({ session }: { session: ConnectionSession }): React.JSX.Element {
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const dms = useStore(session.socialStore, (state) => state.dms);
  const relationships = useStore(session.socialStore, (state) => state.relationships);
  const readStates = useStore(session.readStateStore, (states) => states);
  const background = useStore(socialDirectory, (snapshots) => snapshots);
  // Live badge toggle (oak's onApplied badge rebuild) — see Sidebar.
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const activeUnread = dms.reduce(
    (total, dm) => total + (readStates.get(dm.id)?.unreadCount ?? 0),
    0,
  );
  const backgroundUnread = background.reduce(
    (total, snapshot) => total + [...snapshot.dmCounts.values()].reduce((sum, counts) => sum + counts.unread, 0),
    0,
  );
  const pendingTotal = relationships.filter((entry) => entry.type === "PENDING_INCOMING").length
    + background.reduce(
      (total, snapshot) => total + snapshot.relationships.filter((entry) => entry.type === "PENDING_INCOMING").length,
      0,
    );
  const dmUnread = activeUnread + backgroundUnread + pendingTotal;
  return (
    <div className={"rail-wrap home" + (dmMode ? " active" : "")} onClick={toggleHomeMode}>
      {dmMode ? <span className="rail-pill" /> : null}
      {/* The app logo in the Home button (src/renderer/public/logo.png,
          monochrome master); click semantics unchanged. */}
      <div className="rail-icon home"><img className="rail-logo" src="logo.png" alt="" draggable={false} /></div>
      {!dmMode && badgeEnabled && dmUnread > 0 ? (
        <span className="rail-badge">{dmUnread > 99 ? "99+" : dmUnread}</span>
      ) : null}
    </div>
  );
}
