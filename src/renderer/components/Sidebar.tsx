import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  closeDiscussionView,
  closeServerMenu,
  connectionDirectory,
  dismissUpdateBanner,
  joinVoiceGuarded,
  openDiscussion,
  openServerMenu,
  proceedUpdateDownload,
  roomAudio,
  setActiveChannel,
  setSidebarDiscussions,
  settingsStore,
  skipUpdateVersion,
  toggleRoomView,
  updateInterruptsMedia,
  watchShareInWindow,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { memberNameColor } from "../../domain/logic/roster-grouping";
import { feedHasLiveVideo } from "../../core/classifier";
import { displayNameOf } from "../../domain/logic/display-name";
import { groupMineByChannel, sortMineByActivity } from "../../domain/logic/discussions-view";
import {
  flattenGroupsForPersist,
  groupChannelsByCategory,
  type ChannelGroups,
} from "../../domain/logic/channel-groups";
import { applyChannelDrop, type DragSubject, type DropList } from "../../domain/logic/channel-drag";
import { shouldShowUpdateBanner } from "../../domain/logic/update-policy";
import { filterVoiceInviteCandidates, onlineVoiceInviteCandidates } from "../../domain/logic/voice-invite";
import { notifications } from "../notifications";
import { log } from "../../logging";
import type { Channel } from "../../types";
import { MANAGE_CHANNELS_PERMISSION } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { CreateChannelModal } from "./CreateChannelModal";
import { Avatar } from "./Avatar";
import { ChannelGlyph } from "./ChannelGlyph";
import { VoiceMarks, VoiceMemberCard } from "./VoiceRoom";
import { DmSidebar } from "./DmSidebar";

/**
 * The channel column (oak's 220px channel-pane). Channel CRUD lives in the
 * context menu (right-click) and the section "+" buttons; the member roster is
 * NOT here anymore — it is its own right-hand column (MembersPane, oak parity).
 *
 * Categories (Discord's sections): uncategorized TEXT rows first, uncategorized
 * VOICE after them, then one collapsible block per CATEGORY (text above voice —
 * user decision). Reordering/moving is a POINTER DRAG over the channel rows and
 * category headers (the Server Settings roles' mechanics), persisted as one
 * PUT /api/channels/order.
 */
export function Sidebar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const roster = useStore(session.rosterStore, (roster) => roster);
  const readStates = useStore(session.readStateStore, (states) => states);
  const voiceMarks = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const participants = useStore(appStore, (state) => state.participants);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const canManageChannels = useStore(session.permissionStore, (state) => state.my?.permissions.includes(MANAGE_CHANNELS_PERMISSION) ?? false);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  // The badge toggle is LIVE (oak's onApplied badge rebuild): hiding the
  // counters re-renders the column without waiting for the next message.
  const badgeEnabled = useStore(settingsStore, (settings) => settings.badgeEnabled);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const sidebarDiscussions = useStore(appStore, (state) => state.sidebarDiscussions);
  // The mine list's REFERENCE changes on every store mutation — that is what the memos
  // below key on (the store object itself is a stable singleton).
  const mineDiscussions = useStore(session.discussionsStore, (store) => store.mine());
  const channelIds = useMemo(() => channels.map((channel) => channel.id), [channels]);
  // Derived arrays live in useMemo ONLY (the selector-identity contract): the per-channel
  // tracked counts feed the channel-row badges, the activity-sorted mine feeds the list.
  const trackedCountsByChannel = useMemo(
    () => groupMineByChannel(mineDiscussions, channelIds), [mineDiscussions, channelIds]);
  const trackedDiscussions = useMemo(() => sortMineByActivity(mineDiscussions), [mineDiscussions]);

  // The sidebar's block layout — derived in a memo, never inside a store selector.
  const groups = useMemo(() => groupChannelsByCategory(channels), [channels]);

  const [menu, setMenu] = useState<{ channel: Channel; x: number; y: number } | null>(null);
  // inCategory: the "+" in a CATEGORY header — nested categories do not exist,
  // so the Category tab is hidden there (user decision).
  const [createRequest, setCreateRequest] = useState<{ kind: "TEXT" | "VOICE" | "CATEGORY"; parentId: number | null; inCategory: boolean } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  // The server dropdown (2026-09-21 behind the chevron; 2026-09-24 also on the
  // rail avatar's right-click): the state lives in appStore — ServerMenu.tsx
  // renders the card and the dialogs for BOTH triggers.
  const serverHeaderRef = useRef<HTMLDivElement | null>(null);
  // oak's showVoiceMemberMenu, sidebar surface: the card only fires for a row
  // under the room the VIEWER is in, and never for self.
  const [voiceMemberMenu, setVoiceMemberMenu] = useState<{ username: string; hasShare: boolean; x: number; y: number } | null>(null);
  // Collapsed categories — session-local (no persistence in v1).
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<number>>(new Set());
  // The voice room whose invite picker is open (the name row's hover button).
  const [inviteTarget, setInviteTarget] = useState<Channel | null>(null);

  // The speaking poll (the room view's idiom, oak's pollSpeakingLevels): every
  // 150 ms repaint the SNAPSHOT of who is speaking — the sidebar avatars get
  // the same green ring the room tiles have. Identity-stable on no change, so
  // an idle room never re-renders the column. Runs ONLY while the viewer is in
  // a voice room (the rings exist there and nowhere else) — an idle session
  // used to pay a 6.7 Hz setState evaluation for nothing.
  const [speakingUsers, setSpeakingUsers] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (activeVoiceChannelId === null) {
      setSpeakingUsers((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    const timer = window.setInterval(() => {
      setSpeakingUsers((previous) => {
        const next = roomAudio.speakingSnapshot();
        if (next.size === previous.size && [...next].every((username) => previous.has(username))) {
          return previous;
        }
        return next;
      });
    }, 150);
    return () => window.clearInterval(timer);
  }, [activeVoiceChannelId]);

  // --- Drag-reorder (the RolesSection pointer mechanics) ---------------------
  /** The drag in flight; the dragged row renders as the drop gap. */
  const [dragged, setDragged] = useState<DragSubject | null>(null);
  /** Optimistic layout while a drag is live; null = the store's truth. Dropped
   *  drags KEEP it until the ping refetch lands the same layout (roles lesson). */
  const [previewGroups, setPreviewGroups] = useState<ChannelGroups | null>(null);
  /** The press that MIGHT become a drag (movement past the threshold commits it). */
  const dragCandidateRef = useRef<{ subject: DragSubject; startX: number; startY: number } | null>(null);
  /** The floating copy — FIXED through a portal: the sidebar scrolls, and an
   *  absolute child of a scrolling box gets clipped at its edge (rail bubble). */
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  const viewGroups = previewGroups ?? groups;

  useEffect(() => {
    // Re-asserted on every (re)subscribe (the roles lesson: the commit-time class
    // add is wiped by the cleanup of the previous effect run).
    if (dragged !== null) {
      document.body.classList.add("channel-dragging");
    }
    const onPointerMove = (event: PointerEvent): void => {
      const candidate = dragCandidateRef.current;
      if (candidate === null) {
        return;
      }
      if (dragged === null) {
        if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) < 4) {
          return; // still a press, not a drag — a click must stay a click
        }
        setDragged(candidate.subject);
        document.body.classList.add("channel-dragging");
      }
      if (ghostRef.current !== null) {
        ghostRef.current.style.transform = `translate(${event.clientX + 12}px, ${event.clientY - 14}px)`;
        ghostRef.current.classList.add("positioned");
      }
      if (listRef.current !== null) {
        const target = dropTargetUnderPointer(listRef.current, event.clientY);
        if (target !== null) {
          previewTowards(target);
        }
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      const wasDragging = dragged !== null;
      dragCandidateRef.current = null;
      document.body.classList.remove("channel-dragging");
      if (!wasDragging) {
        return;
      }
      const target = listRef.current !== null ? dropTargetUnderPointer(listRef.current, event.clientY) : null;
      const finalGroups = target !== null ? previewTowards(target) : previewGroups ?? groups;
      if (finalGroups !== groups) {
        void persistGroups(finalGroups);
      }
      // Drop the DRAG (the gap row); the preview stays until the refetch lands.
      setDragged(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && dragged !== null) {
        dragCandidateRef.current = null;
        document.body.classList.remove("channel-dragging");
        setDragged(null);
        setPreviewGroups(null);
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("channel-dragging");
    };
    // groups is the fallback in onPointerUp — a stale closure over an outdated
    // layout would persist the OLD order on a drop with no preview.
  }, [dragged, groups, previewGroups]);

  // The catch-up: once the store's layout equals the optimistic preview, drop the
  // preview and let the store be the truth again.
  useEffect(() => {
    if (previewGroups === null) {
      return;
    }
    const storeFlat = flattenGroupsForPersist(groups);
    const previewFlat = flattenGroupsForPersist(previewGroups);
    if (storeFlat.length === previewFlat.length
      && storeFlat.every((entry, index) =>
        entry.id === previewFlat[index]!.id && entry.parentId === previewFlat[index]!.parentId)) {
      setPreviewGroups(null);
    }
  }, [previewGroups, groups]);

  /** Live-previews the drop; returns the resulting groups for the DROP to persist. */
  const previewTowards = (target: { list: DropList; categoryId?: number; beforeId: number | null }): ChannelGroups => {
    if (dragged === null) {
      return previewGroups ?? groups;
    }
    const next = applyChannelDrop(previewGroups ?? groups, dragged, target);
    if (next === null) {
      return previewGroups ?? groups;
    }
    setPreviewGroups(next);
    return next;
  };

  const persistGroups = async (finalGroups: ChannelGroups): Promise<void> => {
    try {
      await session.reorderChannels(flattenGroupsForPersist(finalGroups));
      // The preview STAYS until the channels-changed refetch lands the same layout.
    } catch (reorderError) {
      const message = reorderError instanceof Error ? reorderError.message : String(reorderError);
      log.error("sidebar", `channel reorder failed: ${message}`);
      setPreviewGroups(null);
    }
  };

  /** The pointer press on a draggable row (left button, managers only). */
  const onDragRowPointerDown = (subject: DragSubject) => (event: React.PointerEvent) => {
    if (event.button === 0 && canManageChannels) {
      dragCandidateRef.current = { subject, startX: event.clientX, startY: event.clientY };
    }
  };

  // Hit-testing rows by pointer geometry (the roles discipline: the CONTAINER is
  // stable while the preview reorders the rows under the cursor).
  const dropTargetUnderPointer = (container: Element, clientY: number): {
    list: DropList; categoryId?: number; beforeId: number | null;
  } | null => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-drag-list]"));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const list = row.dataset.dragList as DropList;
        const categoryId = row.dataset.categoryId !== undefined ? Number(row.dataset.categoryId) : undefined;
        const rowId = row.dataset.dragChannelId !== undefined
          ? Number(row.dataset.dragChannelId)
          : row.dataset.dragCategoryId !== undefined ? Number(row.dataset.dragCategoryId) : null;
        if (rowId === null || row.dataset.dragGap === "true") {
          return null; // over the gap itself — keep the current preview
        }
        const belowTarget = clientY > rect.top + rect.height / 2;
        if (!belowTarget) {
          return { list, categoryId, beforeId: rowId };
        }
        // Below the row: before the NEXT row of the SAME list (any category),
        // else append. A category header "below" means before the next HEADER.
        const wantsCategoryRow = list === "categories";
        for (let nextIndex = rowIndex + 1; nextIndex < rows.length; nextIndex++) {
          const nextRow = rows[nextIndex]!;
          if (nextRow.dataset.dragList === list && nextRow.dataset.categoryId === row.dataset.categoryId) {
            const nextId = nextRow.dataset.dragChannelId !== undefined
              ? Number(nextRow.dataset.dragChannelId)
              : nextRow.dataset.dragCategoryId !== undefined ? Number(nextRow.dataset.dragCategoryId) : null;
            return { list, categoryId, beforeId: nextId };
          }
          if (wantsCategoryRow && nextRow.dataset.dragList === "categories") {
            const nextId = nextRow.dataset.dragCategoryId !== undefined
              ? Number(nextRow.dataset.dragCategoryId) : null;
            return { list, categoryId, beforeId: nextId };
          }
        }
        return { list, categoryId, beforeId: null };
      }
    }
    if (rows.length > 0) {
      const last = rows[rows.length - 1]!;
      if (clientY > last.getBoundingClientRect().bottom) {
        // Below every row: the last row's list (the pointer is past the column's end).
        const list = last.dataset.dragList as DropList;
        const categoryId = last.dataset.categoryId !== undefined ? Number(last.dataset.categoryId) : undefined;
        if (dragged?.kind === "category") {
          return { list: "categories", beforeId: null };
        }
        if (list === "categories") {
          // Past the end over the last category's children — append into that category.
          return { list, categoryId, beforeId: null };
        }
        return { list, categoryId, beforeId: null };
      }
    }
    return null;
  };

  const onTextChannelClick = (channel: Channel) => {
    if (!channel.locked) {
      setActiveChannel(channel.id);
    }
  };
  const onVoiceChannelClick = (channel: Channel) => {
    if (channel.locked) {
      return; // oak: a locked channel's click is dead — no join, no error toast
    }
    if (channel.id !== activeVoiceChannelId) {
      joinVoiceGuarded(channel); // asks about ending a live call first
    } else {
      // oak: clicking the room you are ALREADY in opens (toggles) its room view.
      toggleRoomView();
    }
  };
  const openMenu = (channel: Channel) => (event: React.MouseEvent) => {
    event.preventDefault();
    // oak parity: without MANAGE_CHANNELS the right-click does nothing at all.
    if (canManageChannels) {
      setMenu({ channel, x: event.clientX, y: event.clientY });
    }
  };
  const menuItems: ContextMenuItem[] = menu === null ? [] : [
    { label: "Rename channel", action: () => setRenameTarget(menu.channel) },
    { label: "Delete channel", danger: true, action: () => setDeleteTarget(menu.channel) },
  ];

  const toggleCollapsed = (categoryId: number): void => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  // One TEXT row — shared by the uncategorized list and the category blocks.
  const textChannelRow = (channel: Channel, list: "uncat-text" | "cat-text", categoryId?: number) => {
    const unread = readStates.get(channel.id);
    const trackedCount = trackedCountsByChannel.get(channel.id) ?? 0;
    const isDragged = dragged?.kind === "channel" && dragged.channel.id === channel.id;
    return (
      <div
        key={channel.id}
        className={"channel-row"
          + (channel.id === activeChannelId ? " active" : "")
          + (channel.locked ? " locked" : "")
          + (isDragged ? " drop-gap" : "")}
        data-drag-list={list}
        data-category-id={categoryId}
        data-drag-channel-id={channel.id}
        data-drag-gap={isDragged ? "true" : undefined}
        title={channel.locked ? "Locked for you" : undefined}
        onClick={() => onTextChannelClick(channel)}
        onContextMenu={openMenu(channel)}
        onPointerDown={onDragRowPointerDown({ kind: "channel", channel })}
      >
        <ChannelGlyph voice={false} locked={channel.locked} />
        <span className="channel-name">{channel.name}</span>
        {/* The tracked-discussions count: how many threads I follow live here.
            Clicking the badge switches the column to the discussions list
            (user request) — it must not open the channel underneath. */}
        {trackedCount > 0 ? (
          <span
            className="channel-badge discussions"
            title={trackedCount === 1 ? "1 discussion you follow — click to show discussions" : `${trackedCount} discussions you follow — click to show discussions`}
            onClick={(event) => {
              event.stopPropagation();
              setSidebarDiscussions(true);
            }}
          >
            <span className="icon mdi-comment-text-outline" />
            {trackedCount}
          </span>
        ) : null}
        {/* oak: the badge never shows on the SELECTED channel (refresh gating). */}
        {channel.id !== activeChannelId && badgeEnabled && unread !== undefined && unread.unreadCount > 0 ? (
          <span className={"channel-badge" + (unread.mentionCount > 0 ? " mention" : "")}>
            {unread.unreadCount > 99 ? "99+" : unread.unreadCount}
          </span>
        ) : null}
      </div>
    );
  };

  // One VOICE block — oak's ChannelNode is ONE VBox: the name row AND the member
  // list below it share the hover/active background and form a SINGLE click
  // target. The DRAG handle is the name row only (the member rows own their
  // right-click card).
  const voiceChannelBlock = (channel: Channel, list: "uncat-voice" | "cat-voice", categoryId?: number) => {
    const isDragged = dragged?.kind === "channel" && dragged.channel.id === channel.id;
    return (
      <div
        key={channel.id}
        className={"voice-channel"
          + (channel.id === activeVoiceChannelId ? " active voice-live" : "")
          + (channel.locked ? " locked" : "")
          + (isDragged ? " drop-gap" : "")}
        data-drag-list={list}
        data-category-id={categoryId}
        data-drag-gap={isDragged ? "true" : undefined}
        title={channel.locked ? "Locked for you" : undefined}
        onClick={() => onVoiceChannelClick(channel)}
        onContextMenu={openMenu(channel)}
        data-drag-channel-id={channel.id}
      >
        <div
          className="channel-row"
          onPointerDown={onDragRowPointerDown({ kind: "channel", channel })}
        >
          <ChannelGlyph voice locked={channel.locked} />
          <span className="channel-name">{channel.name}</span>
          {!channel.locked ? (
            <button
              className="voice-invite-button"
              title="Invite friends to this room"
              onClick={(event) => {
                // Must not join the room (the block's click target).
                event.stopPropagation();
                setInviteTarget(channel);
              }}
            >
              <span className="icon mdi-account-plus" />
            </button>
          ) : null}
        </div>
        {[...(roster.voiceMembers.get(channel.id) ?? [])].map((username) => {
          // oak: the voice-row nick is the top colored role, like the roster.
          const member = members.find((entry) => entry.username === username);
          const nickColor = member !== undefined ? memberNameColor(member, roles) : null;
          // The live-share watch glyph: only on rows of MY room (a subscription
          // needs this client's own SFU session in that room).
          const shareFeed = channel.id === activeVoiceChannelId
            ? participants.find((feed) => feed.display === username && feedHasLiveVideo(feed)) ?? null
            : null;
          return (
            <div
              key={username}
              className={"voice-member-row" + (speakingUsers.has(username) ? " speaking" : "")}
              onContextMenu={(event) => {
                // The member card and the CHANNEL menu are separate zones in
                // oak (distinct consumers) — stop the bubble so a right-click
                // on a member does not also open the channel menu.
                event.preventDefault();
                event.stopPropagation();
                if (channel.id === activeVoiceChannelId && username !== ownUsername) {
                  setVoiceMemberMenu({
                    username,
                    hasShare: participants.some((feed) => feed.display === username && feedHasLiveVideo(feed)),
                    x: event.clientX,
                    y: event.clientY,
                  });
                }
              }}
            >
              <Avatar session={session} username={username} size={20} />
              <span className="member-name" style={nickColor !== null ? { color: nickColor } : undefined}>
                {displayNameOf(roster.users, username)}{username === ownUsername ? " (you)" : ""}
              </span>
              <VoiceMarks marks={voiceMarks.get(username)} />
              {shareFeed !== null ? (
                <button
                  className="voice-watch-button"
                  title="Watch screen share"
                  onClick={(event) => {
                    // Must not join the room (the block's click target). The
                    // window opens DIRECTLY (user request 2026-10-05) — the
                    // share audio still plays through this window's playout.
                    event.stopPropagation();
                    void watchShareInWindow(shareFeed.feedId);
                  }}
                >
                  <span className="icon mdi-monitor-eye" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  // One collapsible category block. An EMPTY block renders only for managers —
  // a plain member would see a header with nothing under it (and could never
  // fill or delete it anyway).
  const categoryBlock = (group: { category: Channel; textChannels: Channel[]; voiceChannels: Channel[] }) => {
    const collapsed = collapsedIds.has(group.category.id);
    const isDraggedCategory = dragged?.kind === "category" && dragged.category.id === group.category.id;
    const empty = group.textChannels.length === 0 && group.voiceChannels.length === 0;
    if (empty && !canManageChannels) {
      return null;
    }
    return (
      <div key={group.category.id} className="category-block">
        <div
          className={"category-header" + (isDraggedCategory ? " drop-gap" : "")}
          data-drag-list="categories"
          data-category-id={group.category.id}
          data-drag-category-id={group.category.id}
          data-drag-gap={isDraggedCategory ? "true" : undefined}
          onClick={() => toggleCollapsed(group.category.id)}
          onContextMenu={openMenu(group.category)}
          onPointerDown={onDragRowPointerDown({ kind: "category", category: group.category })}
        >
          <span className={"icon mdi-chevron-down category-chevron" + (collapsed ? " collapsed" : "")} />
          <span className="category-name">{group.category.name}</span>
          {canManageChannels ? (
            <button
              className="section-add"
              title="Create channel in this category"
              onClick={(event) => {
                event.stopPropagation();
                setCreateRequest({ kind: "TEXT", parentId: group.category.id, inCategory: true });
              }}
            >+</button>
          ) : null}
        </div>
        {!collapsed ? (
          <div className="category-children">
            {group.textChannels.map((channel) => textChannelRow(channel, "cat-text", group.category.id))}
            {group.voiceChannels.map((channel) => voiceChannelBlock(channel, "cat-voice", group.category.id))}
            {empty ? <div className="category-empty">No channels yet</div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="sidebar" ref={listRef}>
      {dmMode ? (
        <DmSidebar session={session} />
      ) : (
        <>
          <div
            className="sidebar-server-header"
            ref={serverHeaderRef}
            onClick={() => {
              // Honest toggle: with the header passed as the menu's ANCHOR its
              // pointerdown does not outside-dismiss first, so a second click
              // lands here with the menu still open and closes it (live report:
              // it used to dismiss-then-reopen and never go away).
              if (appStore.getSnapshot().serverMenu?.recordId === session.recordId) {
                closeServerMenu();
                return;
              }
              const rect = serverHeaderRef.current?.getBoundingClientRect();
              if (rect !== undefined) {
                openServerMenu(session.recordId, rect.left, rect.bottom + 4, serverHeaderRef.current);
              }
            }}
          >
            <span className="sidebar-server-name">
              {connectionDirectory.get(session.recordId)?.cachedServerName ?? session.hostUrl().replace(/^https?:\/\//, "")}
            </span>
            <span className="icon mdi-chevron-down sidebar-server-chevron" />
          </div>
          {/* The client self-update banner (2026-10-20) sits ABOVE the ownership
              offer — an update of the app itself outranks a server matter. */}
          <UpdateBanner />
          {/* The recipient's PERSISTENT ownership notification: rendered while THIS
              member holds an incoming pending offer (fetched at session start — it
              survives the recipient being offline — and refreshed on every
              /user/queue/ownership push). */}
          <OwnershipBanner session={session} />
          {sidebarDiscussions ? (
            <>
              {/* No switch dropdown anymore (user decision 2026-10-05): entering
                  the discussions side is the channel-row badge alone; leaving is
                  this back button — the room-view back glyph, compact so the
                  section row keeps its fixed 24px. It also closes an open thread
                  view: "back" lands on the last text channel, not just the list. */}
              <div className="sidebar-section-title">
                <span>Discussions</span>
                <button
                  className="sidebar-back"
                  title="Back to channels"
                  onClick={() => {
                    setSidebarDiscussions(false);
                    closeDiscussionView();
                  }}
                >
                  <span className="icon mdi-chevron-left" />
                </button>
              </div>
              <DiscussionsList
                session={session}
                channels={channels}
                discussions={trackedDiscussions}
              />
            </>
          ) : (
            <>
              <div className="sidebar-section-title">
                <span>Channels</span>
                {canManageChannels ? (
                  <button className="section-add" title="Create channel" onClick={() => setCreateRequest({ kind: "TEXT", parentId: null, inCategory: false })}>+</button>
                ) : null}
              </div>
              {viewGroups.uncategorizedText.map((channel) => textChannelRow(channel, "uncat-text"))}
              {viewGroups.uncategorizedVoice.map((channel) => voiceChannelBlock(channel, "uncat-voice"))}
              {viewGroups.categories.map(categoryBlock)}
            </>
          )}
        </>
      )}

      {dragged !== null ? (() => {
        // The floating snapshot of the dragged row — FIXED through a portal (the
        // scrolling sidebar would clip an absolutely positioned child).
        const ghostName = dragged.kind === "category" ? dragged.category.name : dragged.channel.name;
        const ghostVoice = dragged.kind === "channel" && dragged.channel.type === "VOICE";
        return createPortal(
          <div ref={ghostRef} className="channel-row channel-drag-ghost">
            <ChannelGlyph voice={ghostVoice} locked={false} />
            <span className="channel-name">{ghostName}</span>
          </div>,
          document.body,
        );
      })() : null}

      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
      {voiceMemberMenu !== null ? (
        <VoiceMemberCard
          session={session}
          username={voiceMemberMenu.username}
          hasShare={voiceMemberMenu.hasShare}
          x={voiceMemberMenu.x}
          y={voiceMemberMenu.y}
          onClose={() => setVoiceMemberMenu(null)}
        />
      ) : null}
      {createRequest !== null ? (
        <CreateChannelModal
          session={session}
          request={createRequest}
          categories={groups.categories.map((group) => group.category)}
          onClose={() => setCreateRequest(null)}
        />
      ) : null}

      {renameTarget !== null ? <RenameChannelModal session={session} channel={renameTarget} onClose={() => setRenameTarget(null)} /> : null}
      {deleteTarget !== null ? <DeleteChannelModal session={session} channel={deleteTarget} onClose={() => setDeleteTarget(null)} /> : null}
      {inviteTarget !== null ? (
        <VoiceInvitePickerModal session={session} channel={inviteTarget} onClose={() => setInviteTarget(null)} />
      ) : null}
    </aside>
  );
}

/**
 * The client self-update banner (2026-10-20, under the server header — the
 * ownership-banner card idiom): "Space X is available" with Update / Cancel /
 * Skip this version. Update CONFIRMS first when a voice/call session is live
 * (declining keeps the banner); during the download the card becomes a
 * progress bar with a Cancel-download button, and a finished download installs
 * automatically (silent install, the app relaunches itself). Cancel only hides
 * the card until the next check re-arms it; Skip persists the version in
 * settings — the General section still offers the update either way.
 */
function UpdateBanner(): React.JSX.Element | null {
  const update = useStore(appStore, (state) => state.update);
  const dismissed = useStore(appStore, (state) => state.updateDismissed);
  const skippedVersion = useStore(settingsStore, (settings) => settings.skippedUpdateVersion);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (dismissed || !shouldShowUpdateBanner(update.version, skippedVersion) || update.status === "idle") {
    return null;
  }

  const startUpdate = (): void => {
    if (updateInterruptsMedia()) {
      setConfirmOpen(true);
      return;
    }
    proceedUpdateDownload();
  };

  const percent = Math.round(update.percent ?? 0);
  return (
    <div className="update-banner">
      <div className="update-banner-text">
        <span className="icon mdi-update" />
        {update.status === "downloading" ? (
          <span>{`Downloading update — ${percent}%`}</span>
        ) : update.status === "failed" ? (
          <span>Download failed — check the log and try again</span>
        ) : (
          <span>{`Space ${update.version} is available`}</span>
        )}
      </div>
      {update.status === "downloading" ? (
        <div className="update-progress-row">
          <div className="update-progress"><div className="update-progress-fill" style={{ width: `${percent}%` }} /></div>
          <span className="update-progress-note">{formatUpdateSpeed(update.bytesPerSecond)}</span>
        </div>
      ) : null}
      <div className="ownership-banner-actions">
        {update.status === "downloading" ? (
          <button className="ghost" onClick={() => window.spaceUpdates?.cancelDownload()}>Cancel download</button>
        ) : (
          <>
            <button className="primary" onClick={startUpdate}>Update</button>
            <button className="ghost" onClick={() => dismissUpdateBanner()}>Cancel</button>
            <button className="ghost" onClick={() => { if (update.version !== null) { skipUpdateVersion(update.version); } }}>Skip this version</button>
          </>
        )}
      </div>
      {confirmOpen ? (
        <Modal title="Update SPACE" onClose={() => setConfirmOpen(false)}>
          <div className="modal-note">
            Updating restarts the client now — an active voice or call session will be dropped.
          </div>
          <div className="modal-actions left">
            <button className="ghost" onClick={() => setConfirmOpen(false)}>Not now</button>
            <button className="primary" onClick={() => { setConfirmOpen(false); proceedUpdateDownload(); }}>Update now</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** "4.2 MB/s" / "312 KB/s" for the download row; empty when unknown. */
function formatUpdateSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "";
  }
  const megabytes = bytesPerSecond / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

/**
 * The recipient's incoming ownership-offer banner (under the server header): the
 * persistent accept/decline notification. Accept makes this member the owner
 * (crowns and permission masks flip via the members refetch); decline returns
 * the offer to the sender.
 */
function OwnershipBanner({ session }: { session: ConnectionSession }): React.JSX.Element | null {
  const pending = useStore(session.ownershipStore, (state) => state.pending);
  const selfUserId = session.selfUserId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending === null || selfUserId === null || pending.toUserId !== selfUserId) {
    return null;
  }

  const decide = async (accept: boolean): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (accept) {
        await session.acceptOwnershipTransfer(pending.id);
        notifications.showToast({ title: "Server", channelName: "", body: "You are now the owner of this server." });
      } else {
        await session.declineOwnershipTransfer(pending.id);
      }
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : String(decideError));
      setBusy(false);
    }
  };

  return (
    <div className="ownership-banner">
      <div className="ownership-banner-text">
        <span className="icon mdi-crown" />
        <span>{`"${pending.fromDisplayName}" offers you ownership of this server`}</span>
      </div>
      <div className="error-line">{error ?? ""}</div>
      <div className="ownership-banner-actions">
        <button className="primary" disabled={busy} onClick={() => void decide(true)}>Accept</button>
        <button className="ghost" disabled={busy} onClick={() => void decide(false)}>Decline</button>
      </div>
    </div>
  );
}

/**
 * The hover button's picker: EVERY online member of the server except yourself
 * (user decision — Discord parity; friendship is not a precondition), searchable
 * by nickname, multi-select; one STOMP invite per pick (the server stamps the
 * sender and resolves the room's name; offline members are not listed — a live
 * card is the only delivery).
 */
function VoiceInvitePickerModal({ session, channel, onClose }: {
  session: ConnectionSession;
  channel: Channel;
  onClose: () => void;
}): React.JSX.Element {
  const members = useStore(session.memberStore, (state) => state.members);
  const presence = useStore(session.rosterStore, (state) => state.presence);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const candidates = useMemo(
    () => onlineVoiceInviteCandidates(members, presence, ownUsername),
    [members, presence, ownUsername]);
  const shown = useMemo(
    () => filterVoiceInviteCandidates(candidates, query),
    [candidates, query]);

  const send = (): void => {
    for (const candidate of candidates) {
      if (picked.has(candidate.userId)) {
        session.sendVoiceInvite(channel.id, candidate.username);
      }
    }
    onClose();
  };

  return (
    <Modal title={`Invite to ${channel.name}`} onClose={onClose} narrow>
      <input
        autoFocus
        type="text"
        className="invite-picker-search"
        placeholder="Search members"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="friend-picker-list">
        {shown.length === 0 ? (
          <div className="settings-empty">
            {candidates.length === 0 ? "Nobody is online." : "No members match."}
          </div>
        ) : shown.map((candidate) => (
          <label key={candidate.userId} className="settings-check friend-picker-row">
            <input
              type="checkbox"
              checked={picked.has(candidate.userId)}
              onChange={(event) => {
                const next = new Set(picked);
                if (event.target.checked) {
                  next.add(candidate.userId);
                } else {
                  next.delete(candidate.userId);
                }
                setPicked(next);
              }}
            />
            <Avatar session={session} username={candidate.username} size={24} />
            <span>{candidate.nickname}</span>
          </label>
        ))}
      </div>
      <div className="modal-actions left">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={picked.size === 0} onClick={send}>
          Invite{picked.size > 0 ? ` (${picked.size})` : ""}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The sidebar's discussions side (the toggle under the server header): the threads THIS
 * viewer follows, most recently active first. Tiles clone the search-hit idiom — the
 * parent channel line over the origin author + a two-line snippet — plus a per-tile
 * unsubscribe (mdi-close): tracking is personal, untracking hides it from this list only.
 */
function DiscussionsList({ session, channels, discussions }: {
  session: ConnectionSession;
  channels: readonly Channel[];
  discussions: readonly import("../../types").Discussion[];
}): React.JSX.Element {
  const activeDiscussionId = useStore(appStore, (state) => state.activeDiscussion?.discussionId ?? null);
  const parentName = (parentChannelId: number): string =>
    channels.find((channel) => channel.id === parentChannelId)?.name ?? "#deleted";
  return (
    <>
      {/* No section title here — Sidebar renders the "Discussions" caption with the
          back button (the channels↔discussions switch) above this list. */}
      {discussions.length === 0 ? (
        <div className="discussions-empty">No tracked discussions — start one from a message's context menu.</div>
      ) : (
        <div className="discussions-list">
          {discussions.map((discussion) => (
            <div
              key={discussion.id}
              className={"discussion-tile" + (discussion.id === activeDiscussionId ? " active" : "")}
              onClick={() => openDiscussion(discussion)}
            >
              <div className="discussion-tile-row">
                <span className="icon mdi-pound" />
                <span className="discussion-tile-channel">{parentName(discussion.parentChannelId)}</span>
                <button
                  className="discussion-tile-untrack"
                  title="Stop following this discussion"
                  onClick={(event) => {
                    event.stopPropagation();
                    void session.untrackDiscussion(discussion.id).catch((error: unknown) => {
                      log.warn("chat", `untrack discussion ${discussion.id} failed: ${error instanceof Error ? error.message : String(error)}`);
                    });
                  }}
                >
                  <span className="icon mdi-close" />
                </button>
              </div>
              <div className="discussion-tile-snippet">
                <span className="discussion-tile-author">{discussion.originAuthorName}</span>
                {discussion.originSnippet.length > 0 ? ` ${discussion.originSnippet}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RenameChannelModal({ session, channel, onClose }: {
  session: ConnectionSession;
  channel: Channel;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === channel.name) {
      if (trimmed === channel.name) {
        onClose();
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.renameChannel(channel.id, trimmed);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rename ${channel.type === "CATEGORY" ? channel.name : `#${channel.name}`}`} onClose={onClose}>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
      />
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || name.trim().length === 0} onClick={() => void submit()}>Rename</button>
      </div>
    </Modal>
  );
}

function DeleteChannelModal({ session, channel, onClose }: {
  session: ConnectionSession;
  channel: Channel;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.deleteChannel(channel.id);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${channel.type === "CATEGORY" ? `category "${channel.name}"?` : `channel "${channel.name}"?`}`} onClose={onClose}>
      <div className="modal-note">
        {channel.type === "CATEGORY"
          ? "An empty category is removed for everyone. A non-empty one must be emptied first."
          : "Its messages will be permanently removed."}
      </div>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy} onClick={() => void submit()}>Delete</button>
      </div>
    </Modal>
  );
}
