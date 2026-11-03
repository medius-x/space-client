import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { useT } from "../hooks/useT";
import { currentLang, type Translator } from "../../domain/i18n/i18n";
import { warmLegacyAttachmentDims } from "../media-dims-warmup";
import { bodyGlyphWidthPx, truncateTextToWidth } from "../glyph-metrics";
import { ackActiveChannel, appStore, forwardCrossInstance, forwardRequestUpload, forwardUploadBytes } from "../runtime";
import { closeDiscussionForEveryone, closeDiscussionView, openDiscussion, openDraftDiscussion } from "../runtime";
import { connectionDirectory, settingsStore } from "../runtime";
import { RecordTokenStorage } from "../../domain/session/connection-record";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { HISTORY_PAGE, NEWER_PAGE } from "../../domain/session/connection-session";
import { RestClient } from "../../core/rest";
import { log } from "../../logging";
import { computeGroupStarts, continuesGroup, formatHeaderStamp, formatTimeOfDay, toEpochMs, type GroupableMessage } from "../../domain/logic/message-grouping";
import { lastServerMessageId } from "../../domain/stores/MessageStore";
import { firstHttpUrl, segmentMessageContent, type MessageSegment } from "../../domain/logic/mention-segmenter";
import { wrapSelectionInMarker } from "../../domain/logic/composer-format";
import {
  applyLiveFormatCommand,
  createComposerEditor,
  insertPlainText,
  loadComposerText,
  serializeComposerRoot,
  $caretModelOffsets,
} from "../lexical-composer";
import {
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  type LexicalCommand,
  type LexicalEditor,
} from "lexical";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import {
  filterEmojis,
  isEmojiOnlyMessage,
} from "../../domain/logic/emoji-picker";
import { filterStickerPacks, stickerForwardFileName } from "../../domain/logic/sticker-picker";
import {
  customEmojiNameOfReactionSlug,
  filterBuiltInReactions,
  pushRecentExpression,
  reactionPickerPosition,
  resolveRecentExpressionEntries,
  type BuiltInReaction,
  type RecentExpressionEntry,
} from "../../domain/logic/reaction-picker";
import { displayNameOf } from "../../domain/logic/display-name";
import { dmBlockHintText, dmSendBlockReason } from "../../domain/logic/dm-gating";
import { tileReplyLabel } from "../../domain/logic/discussions-view";
import { linkPreviewFor, type LinkPreview } from "../link-preview";
import { notifications } from "../notifications";
import { dmDisplayName } from "../../domain/logic/dm-display";
import { memberNameColor } from "../../domain/logic/roster-grouping";
import { paletteColor } from "../../domain/logic/user-palette";
import type { Channel, ChannelMyPermissions, CustomEmoji, Discussion, DmChannel, ForwardInfo, Message, ReplyInfo, Sticker, StickerRef } from "../../types";
import { REACTION_CATALOG, REACTION_GLYPH_BY_SLUG } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { AttachmentView, attachmentUsableWidth } from "./AttachmentView";
import { isImageFile } from "../../domain/logic/attachment-layout";
import { wordRangeAt, withAddedSpellWord } from "../../domain/logic/spell-word";
import { estimateRowHeight, QUOTE_DEPTH_MAX } from "../../domain/logic/message-row-height";
import { learnedDims } from "../media-dims";
import { Avatar } from "./Avatar";
import { NowPlayingBar } from "./NowPlayingBar";
import { PinCard } from "./PinCard";

/** The server's per-message attachment cap (MAX_ATTACHMENTS). */
const MAX_STAGED_FILES = 10;

interface StagedFile {
  id: string;
  file: File;
}

/** Jump back-fill cap (oak's MAX_JUMP_BACKFILL_MESSAGES). */
const MAX_JUMP_BACKFILL = 1000;
const HIGHLIGHT_TTL_MS = 1500;

/** Records a used expression into the persisted MRU — the "Latest" row BOTH pickers
 *  share (a reaction pick and a composer insert feed the same list, user request
 *  2026-09-30). Reads the snapshot at call time, never a stale closure; the
 *  persistedGain category — a quiet write-through, not surfaced in settings. */
const recordRecentExpression = (slug: string): void => {
  settingsStore.apply({
    recentExpressions: pushRecentExpression(settingsStore.getSnapshot().recentExpressions, slug),
  });
};

/**
 * A jump's first scroll lands on ESTIMATED row heights; the real measurements
 * (text wrapping, late image decodes) shift the content under the viewport for
 * a while after — and the virtualizer's own reconcile stops after a single
 * stable frame, so the drift past that frame never gets corrected. Re-assert
 * the centered jump on a decaying schedule until the layout has settled (live
 * report: the first pin-click jump after a cold start landed "somewhere in the
 * chat"; the second click — every row already measured — landed on the pin).
 * ANY user scroll/pointer/key input cancels the ladder: it must never fight
 * the reader. Returns the cancel; the caller chains jumps through a ref so a
 * new jump replaces the previous ladder instead of racing it.
 */
function scheduleSettlingJump(
  listRef: { current: VirtualListHandle | null },
  key: string,
  onAttempt?: () => void,
): () => void {
  const DELAYS_MS = [0, 120, 360, 840, 1800, 3000];
  const timers: number[] = [];
  let cancelled = false;
  const cancel = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    for (const timer of timers) {
      window.clearTimeout(timer);
    }
    for (const eventType of ["wheel", "pointerdown", "keydown"] as const) {
      window.removeEventListener(eventType, cancel, true);
    }
  };
  // Capture-phase, once: the FIRST sign of the user taking over the viewport
  // ends the re-assertions. The listeners attach after the jump-triggering
  // click has fully dispatched, so arming input never cancels itself.
  for (const eventType of ["wheel", "pointerdown", "keydown"] as const) {
    window.addEventListener(eventType, cancel, { capture: true, once: true });
  }
  for (const delay of DELAYS_MS) {
    timers.push(window.setTimeout(() => {
      if (cancelled || listRef.current === null) {
        return;
      }
      if (!listRef.current.scrollToKey(key, "center")) {
        cancel(); // the target left the list (a channel switch) — stop re-asserting
        return;
      }
      onAttempt?.();
    }, delay));
  }
  return cancel;
}

/** Actions handed down to every MessageRow. IDENTITY IS THE MEMO CONTRACT: the
 *  rows are memoized, so this object must keep its reference across renders —
 *  members may be value-deps (selectionMode/selection legitimately repaint all
 *  rows at once) or stable callbacks, never a fresh closure over volatile state. */
interface ChatActions {
  setReplyTo(message: Message | null): void;
  beginEdit(message: Message): void;
  beginForward(messages: readonly Message[]): void;
  jumpTo(messageId: number): void;
  selectionMode: boolean;
  selection: ReadonlySet<number>;
  toggleSelected(messageId: number): void;
}

/** Placeholder replaced by MessageList's scroll/backfill wiring — stable by
 *  construction, so the ChatPane-level actions object never churns over it. */
const noopJumpTo = (_messageId: number): void => undefined;

/** Channel-shaped view over a DM row — the chat surface is channel-agnostic. */
function dmViewChannel(dm: DmChannel, selfUsername: string): Channel {
  return {
    id: dm.id,
    name: dmDisplayName(dm, selfUsername),
    type: dm.type,
    createdAt: "",
    locked: false,
    // DMs never group under a category — neutral sidebar fields.
    parentId: null,
    position: 0,
  };
}

/** oak's reply-bar preview: the text with newlines flattened, else the first
 *  attachment's file name (attachment-only replies preview the file, not emptiness). */
function replyPreviewOf(message: Message): string {
  const flattened = (message.content ?? "").replaceAll("\n", " ").trim();
  if (flattened.length > 0) {
    return flattened.slice(0, 100);
  }
  return message.attachments[0]?.fileName ?? "";
}

/** Identity-stable empty for selectors that conditionally read a store list
 *  (the discussion-origin lookup): a fresh [] literal per call would break the
 *  useSyncExternalStore snapshot contract (the M6 infinite-rerender lesson). */
const EMPTY_MESSAGES: readonly Message[] = [];

export function ChatPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const channels = useStore(session.channelStore, (channels) => channels);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  const dm = useStore(session.socialStore, (state) =>
    dmMode && activeDmId !== null ? state.dms.find((entry) => entry.id === activeDmId) ?? null : null,
  );
  const activeChatId = dm !== null ? dm.id : activeChannelId;
  // The discussion view: while a thread of THIS channel is open, the chat surface (list,
  // composer, picker) binds to the DISCUSSION channel; the header/sidebar keep pointing at
  // the parent. The parent's own message list is untouched (still loaded in the store).
  // A DRAFT (discussionId === null, lazy creation) shows the origin panel from the parent's
  // own message list and an empty thread area — nothing exists server-side yet.
  const activeDiscussionState = useStore(appStore, (state) => state.activeDiscussion);
  const openDiscussionEntry = activeDiscussionState !== null && dm === null
    && activeDiscussionState.channelId === activeChannelId ? activeDiscussionState : null;
  // STRICT null check: `?.discussionId == null` would be TRUE for `openDiscussionEntry ===
  // null` too (undefined == null under loose equality) — every plain channel rendered as a
  // draft (live report: no text channel would open). The draft is ONLY an entry that EXISTS
  // and still has no discussion id.
  const isDiscussionDraft = openDiscussionEntry !== null && openDiscussionEntry.discussionId === null;
  const discussionsVersion = useStore(session.discussionsStore, (store) => store.version);
  const openDiscussionRow = useMemo(
    () => openDiscussionEntry !== null && openDiscussionEntry.discussionId !== null
      ? session.discussionsStore.byId(openDiscussionEntry.discussionId) ?? null
      : null,
    [openDiscussionEntry, session, discussionsVersion],
  );
  // The ORIGIN message of the open discussion (draft or live), resolved from the
  // parent channel's loaded list: the panel's frozen snapshot stays as the
  // compact tile, and the FULL row (long text, mosaics, stickers, jumbo emoji —
  // everything the snippet tile cannot show, user request 2026-10-27) renders
  // underneath exactly as it does in the channel. Null — the origin sits outside
  // the loaded window — keeps the tile-only panel, an honest state rather than
  // a broken render. SUBSCRIBED (not read-once): edits and reactions on the
  // origin repaint the panel too. The module-level empty keeps the selector
  // identity-stable when no discussion is open (the M6 snapshot contract).
  const originParentMessages = useStore(
    session.messageStore,
    (store) => (openDiscussionEntry !== null ? store.listFor(openDiscussionEntry.channelId) : EMPTY_MESSAGES),
  );
  const originMessage = useMemo(
    () => openDiscussionEntry !== null
      ? originParentMessages.find((message) => message.id === openDiscussionEntry.originMessageId) ?? null
      : null,
    [openDiscussionEntry, originParentMessages],
  );
  const chatChannelId = openDiscussionEntry?.discussionId ?? activeChatId;
  const messages = useStore(session.messageStore, (store) => store.listFor(chatChannelId ?? -1));
  const channelPermissions = useStore(session.permissionStore, (state) =>
    activeChatId === null || dm !== null ? null : state.channels.get(activeChatId) ?? null,
  );
  // The author's nick is painted by their TOP COLORED ROLE (roster parity,
  // oak) — not by the deterministic palette; non-members (DM peers) stay default.
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const authorColor = useCallback((username: string): string | null => {
    const member = members.find((entry) => entry.username === username);
    return member !== undefined ? memberNameColor(member, roles) : null;
  }, [members, roles]);
  // The rename model: rendered names resolve through the LIVE roster (the
  // username stays the lookup key and never shows).
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const nameOf = useCallback((username: string): string => displayNameOf(rosterUsers, username), [rosterUsers]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Composer focus signal: bumped by reply-arming and file staging so the
  // user can keep typing immediately (user rule 2026-10-19: after Reply or
  // an attach the caret belongs in the composer, at the END of any draft).
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const focusComposer = useCallback(() => {
    setComposerFocusSignal((value) => value + 1);
  }, []);
  const armReply = useCallback((message: Message | null) => {
    setReplyTo(message);
    if (message !== null) {
      focusComposer();
    }
  }, [focusComposer]);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [picker, setPicker] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [reactionQuery, setReactionQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // Any pointer press outside the picker (or Escape) closes it — it must not
  // hang over the chat until a reaction is picked (live M7 polish report).
  useOutsideDismiss(pickerRef, () => setPicker(null));
  // Whatever closed the picker (pick, outside press, Escape), the next open starts
  // from an empty search — a stale filter from another message would confuse.
  useEffect(() => {
    if (picker === null) {
      setReactionQuery("");
    }
  }, [picker]);
  const [forwardQueue, setForwardQueue] = useState<readonly Message[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [staged, setStaged] = useState<readonly StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Drag enter/leave DEPTH (child boundary crossings fire both — a boolean
  // flickered on every child edge). The counter cancels the pairs; the
  // highlight is depth > 0.
  const dragDepthRef = useRef(0);
  // [dnd] diagnostic: the first enter after a long idle and every drop are
  // logged — a wedged native drag controller (the roles-reorder precedent)
  // shows up as "drops stopped while the user swears the cursor was here".
  const lastDragActivityRef = useRef(0);
  // oak: overflow past the cap reports a closing note row ("N more skipped — max 10");
  // the upload spinner reuses the staging box while attachments are being sent.
  const [capNote, setCapNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reactedBy, setReactedBy] = useState<{ x: number; y: number; names: readonly string[] } | null>(null);
  const reactedByRef = useRef<HTMLDivElement | null>(null);
  useOutsideDismiss(reactedByRef, () => setReactedBy(null));
  // The Close confirmation (user request): closing is for EVERYONE and wipes the thread's
  // messages — a bare glyph click must not do that unattended.
  const [closeDiscussionTarget, setCloseDiscussionTarget] = useState<Discussion | null>(null);

  useEffect(() => {
    if (activeChatId === null) {
      return;
    }
    setHistoryError(null);
    setReplyTo(null);
    setEditing(null);
    setSelectionMode(false);
    setSelection(new Set());
    setStaged([]);
    setCapNote(null);
    session.playback.stop(); // one sound at a time — leaving the channel silences it
    // A search-result jump opened this channel ON a message: runtime already issued
    // loadAround — a loadHistory here would be a no-op (isLoaded) anyway, but the skip
    // keeps the two paths from ever interleaving.
    if (appStore.getSnapshot().activeAround?.channelId !== activeChatId) {
      session.loadHistory(activeChatId).then(() => session.scheduleMediaPrefetch(activeChatId)).catch((error: unknown) => {
        setHistoryError(error instanceof Error ? error.message : String(error));
      });
    }
    if (dm === null) {
      session.ensureChannelPermissions(activeChatId).catch((error: unknown) => {
        log.warn("chat", `permission check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      // The channel's every discussion (the tiles under origin messages). Server TEXT
      // channels only — DMs have none. The .discussions topic pushes keep it fresh.
      session.fetchChannelDiscussions(activeChatId).catch((error: unknown) => {
        log.warn("chat", `discussions unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // Pins are fetched once per channel (DMs included — any participant may pin);
    // the .edited pushes keep the list fresh from here on.
    session.loadPinned(activeChatId).catch((error: unknown) => {
      log.warn("chat", `pins unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeChatId, dm, session]);

  const addStagedFiles = (fileList: readonly File[]) => {
    // The merged gate (channel bits AND the DM restriction): the drop overlay
    // lights up exactly when staging actually works — the same expression.
    if (permissions?.attachFiles === false) {
      // No ATTACH_FILES — staging stays empty, the gate line explains. Logged
      // because a silent return is indistinguishable from "nothing happened"
      // in a bug report (the dnd diagnostics round, 2026-10-19).
      log.info("dnd", `drop gated: ATTACH_FILES denied in this channel (${fileList.length} file(s) ignored)`);
      return;
    }
    const known = new Set(staged.map((entry) => `${entry.file.name}:${entry.file.size}`));
    const fresh: StagedFile[] = [];
    let skippedByCap = 0;
    for (const file of fileList) {
      if (staged.length + fresh.length >= MAX_STAGED_FILES) {
        skippedByCap += 1; // oak: the overflow is REPORTED, not silently dropped
        continue;
      }
      const fingerprint = `${file.name}:${file.size}`;
      if (known.has(fingerprint)) {
        continue;
      }
      known.add(fingerprint);
      fresh.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file });
    }
    setCapNote(skippedByCap > 0 ? `${skippedByCap} more skipped — max ${MAX_STAGED_FILES}` : null);
    if (fresh.length > 0) {
      setStaged([...staged, ...fresh]);
      focusComposer(); // files landed — typing continues right away (user rule 2026-10-19)
    }
  };

  // Focus-regain acks the open channel (oak's ack-on-focus).
  useEffect(() => {
    const onWindowFocus = () => ackActiveChannel();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, []);

  const channel = activeChannelId !== null && dm === null
    ? channels.find((entry) => entry.id === activeChannelId) ?? null
    : null;
  // DM rows render through a Channel-shaped adapter — MessageList and the composer
  // stay channel-agnostic (message/history/ack APIs are shared with DMs on the wire).
  // Memoized: MessageList is memoized, so the channel prop must keep its identity —
  // a fresh adapter literal every render used to defeat the row memo in DM views.
  const viewChannel = useMemo(
    () => (dm !== null ? dmViewChannel(dm, ownUsername) : channel),
    [dm, ownUsername, channel],
  );
  const activeAround = useStore(appStore, (state) => state.activeAround);
  // The around target only applies to THIS chat (a search hit in another channel
  // first switches the channel; the field then survives into the new mount).
  const aroundTarget = activeAround !== null && viewChannel !== null && activeAround.channelId === viewChannel.id
    ? activeAround.messageId
    : null;
  // The DM restriction (the subtractive RESTRICT_PRIVATE_MESSAGES role bit): a
  // restricted member may not send, and a 1:1 with one is frozen for BOTH sides
  // (a message toward them would be a received one); a group only silences the
  // restricted member themselves. Reads stay open — the server 403 remains the
  // authority, this only keeps the composer honest.
  const myDmRestricted = useStore(session.permissionStore, (state) => state.my?.dmRestricted === true);
  const dmPeerRestricted = useMemo(() => {
    if (dm === null || dm.type !== "DM") {
      return null;
    }
    const peer = dm.participants.find((participant) => participant.id !== session.selfUserId());
    if (peer === undefined) {
      return null;
    }
    return members.find((member) => member.userId === peer.id)?.dmRestricted ?? null;
  }, [dm, members, session]);
  const dmBlock = dm !== null ? dmSendBlockReason(myDmRestricted, dmPeerRestricted, dm.type === "GROUP_DM") : null;
  const permissions: ChannelMyPermissions | null = dm !== null
    ? { sendMessages: dmBlock === null, attachFiles: dmBlock === null, stream: true }
    : channelPermissions;
  const chatTitlePrefix = dm !== null && dm.type === "DM" ? "@" : "#";
  // The chat-surface binding while a discussion is open: a Channel-shaped adapter over the
  // discussion channel (id is all the send/reaction paths need; permissions resolve through
  // the parent server-side, so the parent's composer bits apply as-is). Memoized with
  // viewChannel (see above) — same row-memo contract.
  const chatChannel: Channel = useMemo(() => (openDiscussionEntry?.discussionId != null
    ? { id: openDiscussionEntry.discussionId, name: "Discussion", type: "TEXT", createdAt: "", locked: false, parentId: null, position: 0 }
    : viewChannel!), // the null viewChannel dead-ends above (chat-empty) before this line
    [openDiscussionEntry?.discussionId ?? null, viewChannel]);

  // The unified reaction picker (phase 3): the composer picker's visual language over
  // BOTH catalogs — the 10 built-in slugs plus the server's custom emojis, one search
  // across the two. A pick toggles the reaction immediately and closes the popup.
  // The Latest row on top is the shared MRU of used expressions (reactions AND
  // composer inserts — one list, both popups).
  const emojiCatalogState = useStore(session.emojiStore, (state) => state);
  const recentExpressions = useStore(settingsStore, (settings) => settings.recentExpressions);
  const builtInMatches = useMemo(
    () => filterBuiltInReactions(REACTION_CATALOG, reactionQuery),
    [reactionQuery],
  );
  const customMatches = useMemo(
    () => (emojiCatalogState.supported ? filterEmojis(emojiCatalogState.emojis, reactionQuery) : []),
    [emojiCatalogState, reactionQuery],
  );
  const recentEntries = useMemo(
    () => resolveRecentExpressionEntries(recentExpressions, emojiCatalogState.byName, reactionQuery),
    [emojiCatalogState, recentExpressions, reactionQuery],
  );
  const pickReaction = (message: Message, slug: string) => {
    const summary = message.reactions.find((candidate) => candidate.reaction === slug);
    const selfId = session.selfUserId();
    const mine = selfId !== null && (summary?.userIds.includes(selfId) ?? false);
    // A failed toggle (revoked permission, network, the 20-distinct cap) must leave a
    // trace — the silent catch made 403s look like dead buttons.
    void session.toggleReaction(chatChannel.id, message.id, slug, mine)
      .catch((reactionError) => log.warn("reactions", `toggle ${slug} failed: ${String(reactionError)}`));
    recordRecentExpression(slug);
    setPicker(null);
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelection(new Set());
  };

  // Identity-stable by construction: flips ONLY on selection changes (which
  // legitimately repaint every row — the hover cluster and click gating read them).
  // Declared ABOVE the dead-end early return below — hooks may never sit behind
  // a conditional return ("Rendered more hooks than during the previous render").
  const actions = useMemo<ChatActions>(() => ({
    setReplyTo: armReply,
    beginEdit: (editTarget: Message) => setEditing(editTarget),
    beginForward: (forwardList: readonly Message[]) => setForwardQueue(forwardList),
    jumpTo: noopJumpTo, // MessageList replaces this with its scroll/backfill wiring
    selectionMode,
    selection,
    toggleSelected: (messageId: number) => {
      setSelection((previous) => {
        const next = new Set(previous);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    },
  }), [armReply, selectionMode, selection]);

  if (viewChannel === null) {
    // Two dead ends, two messages: channels EXIST but every one is locked for
    // this viewer (a role pull) vs a server with no text channels at all.
    const anyVisible = channels.some((entry) => entry.type === "TEXT");
    return (
      <div className="chat-pane">
        <div className="chat-empty">
          {anyVisible ? t("chat.noPermission") : t("chat.noTextChannel")}
        </div>
      </div>
    );
  }

  return (
    <div
      className={"chat-pane" + (dragOver ? " drag-over" : "")}
      onDragEnter={() => {
        const now = Date.now();
        if (now - lastDragActivityRef.current > 30_000) {
          log.info("dnd", `drag entered the chat pane (idle ${Math.round((now - lastDragActivityRef.current) / 1000)}s)`);
        }
        lastDragActivityRef.current = now;
        dragDepthRef.current += 1;
        // The overlay promises a working drop: a viewer without ATTACH_FILES
        // (or a restricted DM) never sees it.
        if (permissions?.attachFiles !== false) {
          setDragOver(true);
        }
      }}
      onDragOver={(event) => {
        // preventDefault stays UNCONDITIONAL — a dropped file must never
        // navigate the window away — and it is what keeps the OS cursor in
        // "drop allowed" while the drag sweeps the pane.
        event.preventDefault();
        lastDragActivityRef.current = Date.now();
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setDragOver(false);
        }
      }}
      onDragEnd={() => {
        dragDepthRef.current = 0;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragOver(false);
        const files = [...event.dataTransfer.files];
        log.info("dnd", `drop: ${files.length} file(s) staged`);
        addStagedFiles(files);
      }}
    >
      {/* The drag-over hint lives in JSX (not a CSS content: string) so it
          follows the UI language — greppable, no attr(data-) indirection. */}
      {dragOver ? <div className="chat-drop-overlay">{t("chat.dropFiles")}</div> : null}
      <div className="chat-header">
        {dm === null
          ? <span className="icon mdi-pound" />
          : <span className="channel-hash">@</span>}
        {" "}{viewChannel.name}
        {selectionMode ? (
          <div className="selection-bar">
            <span>{t("chat.selectedCount", { count: selection.size })}</span>
            <button className="ghost" disabled={selection.size === 0}
              onClick={() => setForwardQueue(messages.filter((message) => selection.has(message.id)))}>{t("chat.forwardVerb")}</button>
            <button className="danger" disabled={selection.size === 0}
              onClick={() => {
                for (const messageId of selection) {
                  void session.deleteMessage(chatChannel.id, messageId).catch((error: unknown) => {
                    log.warn("chat", `bulk delete failed: ${error instanceof Error ? error.message : String(error)}`);
                  });
                }
                exitSelection();
              }}>{t("common.delete")}</button>
            <button className="ghost" onClick={exitSelection}>{t("common.cancel")}</button>
          </div>
        ) : null}
      </div>
      {historyError !== null ? <div className="chat-error">history: {historyError}</div> : null}
      {/* The pin card hides while a discussion is open — the origin panel takes its slot. */}
      {openDiscussionEntry === null ? <PinCard session={session} channelId={viewChannel.id} /> : null}
      {openDiscussionRow !== null ? (
        <DiscussionOriginPanel
          session={session}
          discussion={openDiscussionRow}
          originFull={originMessage}
          onCloseRequest={() => setCloseDiscussionTarget(openDiscussionRow)}
          parentChannel={viewChannel}
          authorColor={authorColor}
          actions={actions}
          editingMessage={editing}
          setEditing={setEditing}
          onMenu={setMenu}
          onPicker={setPicker}
          onReactedBy={setReactedBy}
        />
      ) : null}
      {isDiscussionDraft && originMessage !== null ? (
        <DiscussionOriginPanel
          session={session}
          discussion={null}
          originFull={originMessage}
          onCloseRequest={() => undefined}
          parentChannel={viewChannel}
          authorColor={authorColor}
          actions={actions}
          editingMessage={editing}
          setEditing={setEditing}
          onMenu={setMenu}
          onPicker={setPicker}
          onReactedBy={setReactedBy}
        />
      ) : null}
      <NowPlayingBar session={session} />
      {isDiscussionDraft ? (
        <div className="discussion-draft-hint">{t("chat.discussionDraftHint")}</div>
      ) : (
        <MessageList
          session={session}
          channel={chatChannel}
          messages={messages}
          aroundTarget={aroundTarget}
          actions={actions}
          authorColor={authorColor}
          editing={editing}
          setEditing={setEditing}
          onMenu={setMenu}
          onPicker={setPicker}
          onReactedBy={setReactedBy}
        />
      )}
      {replyTo !== null ? (
        <div className="reply-bar">
          <span>{t("chat.replyingTo")} <strong>@{nameOf(replyTo.authorUsername)}</strong></span>
          <span className="reply-preview">{replyPreviewOf(replyTo)}</span>
          <button className="ghost" onClick={() => setReplyTo(null)}>×</button>
        </div>
      ) : null}
      {staged.length > 0 ? (
        <div className="staging-box">
          {staged.map((entry) => (
            <div key={entry.id} className="staging-row">
              <span className="staging-glyph">📎</span>
              <span className="file-name">{entry.file.name}</span>
              <button className="ghost staging-remove" onClick={() => {
                setStaged((previous) => previous.filter((candidate) => candidate.id !== entry.id));
                setCapNote(null);
              }}>×</button>
            </div>
          ))}
          {uploading ? (
            <div className="staging-row spinner-row">
              <span className="icon mdi-refresh" />
              <span className="file-name">{t("chat.uploading")}</span>
            </div>
          ) : null}
          {capNote !== null ? <div className="staging-skip-note">{capNote}</div> : null}
        </div>
      ) : null}
      {/* oak's applyComposerGating: without SEND_MESSAGES the whole card disappears
          (no gate line); without ATTACH_FILES only the paperclip hides (the composer
          itself stays). A restricted DM shows WHY it is read-only (existing
          conversations stay readable for both sides). */}
      {permissions !== null && !permissions.sendMessages && dmBlock !== null ? (
        <div className="dm-restricted-note">{dmBlockHintText(dmBlock)}</div>
      ) : null}
      {permissions !== null && permissions.sendMessages ? (
        <Composer
          session={session}
          placeholder={t("chat.messagePlaceholder", {
            channel: `${chatTitlePrefix}${viewChannel.name}`,
          }) + (permissions.attachFiles ? t("chat.placeholderAttachSuffix") : "")}
          attachEnabled={permissions.attachFiles}
          allowEmptySend={staged.length > 0}
          focusSignal={composerFocusSignal}
          onCancelReply={replyTo !== null ? () => setReplyTo(null) : null}
          onPaste={(files) => addStagedFiles(files)}
          onSendSticker={(sticker) => session.sendMessageWithSticker(chatChannel.id, sticker, replyTo?.id)}
          onSend={(content) => {
            const files = staged.map((entry) => entry.file);
            if (files.length > 0) {
              setUploading(true); // text-only sends are instant — no spinner (oak)
            }
            // The DRAFT's first send materialises the thread (lazy creation): one call
            // creates the discussion WITH this message, then the view snaps onto it.
            if (isDiscussionDraft && openDiscussionEntry !== null) {
              const origin = openDiscussionEntry;
              const creating = session.startDiscussionWithMessage(
                origin.channelId, origin.originMessageId, files, content.length > 0 ? content : null)
                .then((created) => {
                  appStore.patch({
                    activeDiscussion: {
                      channelId: created.parentChannelId,
                      discussionId: created.id,
                      originMessageId: created.originMessageId,
                    },
                  });
                  return session.openDiscussion(created.id);
                });
              const clearing = creating.then(() => {
                setStaged([]);
                setCapNote(null);
              }).finally(() => {
                setUploading(false);
              });
              setReplyTo(null);
              return clearing;
            }
            const promise = files.length > 0
              ? session.sendMessageWithFiles(chatChannel.id, files, content.length > 0 ? content : null, replyTo?.id)
              : session.sendMessage(chatChannel.id, content, replyTo?.id);
            const clearing = promise.then(() => {
              setStaged([]);
              setCapNote(null);
              // "Wrote once → follows": the server auto-joined the poster as a participant;
              // mirror it locally so the sidebar badge/list update without a mine refetch.
              if (session.discussionsStore.byId(chatChannel.id) !== undefined) {
                session.discussionsStore.setTracked(chatChannel.id, true);
              }
            }).finally(() => {
              setUploading(false);
            });
            setReplyTo(null);
            return clearing;
          }}
        />
      ) : null}

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={messageMenuItems(session, menu.message, actions, {
            beginSelection: () => setSelectionMode(true),
            openPicker: () => setPicker({ message: menu.message, x: menu.x, y: menu.y }),
            confirmDelete: () => setDeleteTarget(menu.message),
            isDm: dm !== null,
            canStartDiscussion: dm === null && openDiscussionEntry === null && (channelPermissions?.sendMessages ?? false),
            canReact: dm !== null || session.permissionStore.can("ADD_REACTIONS"),
          }, t)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {reactedBy !== null ? (
        <div
          ref={reactedByRef}
          className="reacted-by"
          style={{
            left: Math.max(8, Math.min(reactedBy.x, window.innerWidth - 200)),
            top: Math.min(reactedBy.y, window.innerHeight - 8 - Math.min(reactedBy.names.length, 5) * 22 - 16),
          }}
        >
          {reactedBy.names.length === 0 ? (
            <div className="reacted-by-name">{t("chat.nobodyYet")}</div>
          ) : (
            reactedBy.names.map((name) => <div key={name} className="reacted-by-name">{name}</div>)
          )}
        </div>
      ) : null}
      {/* The unified reaction picker (phase 3, user decision): the composer picker's
          language — fixed width, one search, a single scrolling body — anchored to the
          message (fixed coordinates from reactionPickerPosition: below the anchor,
          flipped up near the window bottom). One click = one toggle, popup closes;
          no Stickers tab (stickers are not reactions). */}
      {picker !== null ? (
        <div
          ref={pickerRef}
          className="reaction-picker"
          style={reactionPickerPosition(picker.x, picker.y, window.innerWidth, window.innerHeight)}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            className="picker-search"
            type="text"
            placeholder={t("picker.searchReactions")}
            value={reactionQuery}
            onChange={(event) => setReactionQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setPicker(null);
              }
            }}
          />
          <div className="picker-body">
            {recentEntries.length === 0 && builtInMatches.length === 0 && customMatches.length === 0 ? (
              <div className="picker-empty">{t("picker.nothingMatches")}</div>
            ) : (
              <>
                {recentEntries.length > 0 ? (
                  <div className="picker-section">
                    <div className="picker-section-title">{t("picker.latest")}</div>
                    <div className="expression-tile-grid">
                      {recentEntries.map((entry) => (
                        <RecentExpressionTile
                          key={entry.slug}
                          session={session}
                          entry={entry}
                          onPick={() => pickReaction(picker.message, entry.slug)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {builtInMatches.length > 0 ? (
                  <div className="picker-section">
                    <div className="picker-section-title">{t("picker.builtIn")}</div>
                    <div className="expression-tile-grid">
                      {builtInMatches.map((entry) => (
                        <BuiltInEmojiTile
                          key={entry.slug}
                          entry={entry}
                          onPick={() => pickReaction(picker.message, entry.slug)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {customMatches.length > 0 ? (
                  <div className="picker-section">
                    <div className="picker-section-title">{t("picker.custom")}</div>
                    <div className="emoji-tile-grid">
                      {customMatches.map((emoji) => (
                        <EmojiTile
                          key={emoji.id}
                          session={session}
                          emoji={emoji}
                          onPick={() => pickReaction(picker.message, `:${emoji.name}:`)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
      {forwardQueue !== null ? (
        <ForwardDialog session={session} source={forwardQueue} sourceChannel={viewChannel} onClose={() => setForwardQueue(null)} />
      ) : null}
      {deleteTarget !== null ? (
        <Modal title={t("chat.deleteMessageTitle")} onClose={() => setDeleteTarget(null)}>
          <div className="modal-note">{t("chat.cannotBeUndone")}</div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</button>
            <button className="danger" onClick={() => {
              void session.deleteMessage(deleteTarget.channelId, deleteTarget.id).catch((error: unknown) => {
                log.warn("chat", `delete message ${deleteTarget.id} failed: ${error instanceof Error ? error.message : String(error)}`);
              });
              setDeleteTarget(null);
            }}>{t("common.delete")}</button>
          </div>
        </Modal>
      ) : null}
      {closeDiscussionTarget !== null ? (
        <Modal title={t("chat.closeDiscussionTitle")} onClose={() => setCloseDiscussionTarget(null)}>
          <div className="modal-note">{t("chat.closeDiscussionNote")}</div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setCloseDiscussionTarget(null)}>{t("common.cancel")}</button>
            <button className="danger" onClick={() => {
              closeDiscussionForEveryone(closeDiscussionTarget.id);
              setCloseDiscussionTarget(null);
            }}>{t("chat.closeVerb")}</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function messageMenuItems(
  session: ConnectionSession,
  message: Message,
  actions: ChatActions,
  extra: {
    beginSelection(): void;
    openPicker(): void;
    confirmDelete(): void;
    isDm: boolean;
    canStartDiscussion: boolean;
    canReact: boolean;
  },
  t: Translator,
): ContextMenuItem[] {
  const ownUsername = session.username();
  const canManageMessages = session.permissionStore.can("MANAGE_MESSAGES");
  // An optimistic temp row (negative id) has no server counterpart — the regular
  // entries would all 404 or lie. Only the failure actions apply (the row's
  // right-click is gated to failed rows in MessageRow; this keeps the guard
  // local in case another path opens a menu later).
  if (message.id < 0) {
    return message.delivery === "failed"
      ? [
        {
          label: t("chat.retry"),
          action: () => {
            void session.retryPendingMessage(message.channelId, message.id);
          },
        },
        {
          label: t("common.remove"),
          danger: true,
          action: () => {
            session.discardPendingMessage(message.channelId, message.id);
          },
        },
      ]
      : [];
  }
  const items: ContextMenuItem[] = [];
  // The order follows the user's grouping (2026-11-03): reaction | forward,
  // reply | pin, discussion | edit, select, delete — separated by dividers.
  // Gate SYMMETRY with the hover button (canAddReactions): a member without
  // ADD_REACTIONS must not see a context-menu path the server will 403 (live
  // report: the menu item opened the picker, the pick silently did nothing).
  if (extra.canReact) {
    items.push({ label: t("chat.addReaction"), action: extra.openPicker });
  }
  items.push({ separator: true });
  items.push({ label: t("chat.forwardVerb"), action: () => actions.beginForward([message]) });
  items.push({ label: t("chat.reply"), action: () => actions.setReplyTo(message) });
  items.push({ separator: true });
  // Discord's pin gate: MANAGE_MESSAGES on server channels, ANY participant in a DM
  // (the server's DM branch enforces the same). A 400 means the per-channel cap.
  if (extra.isDm || canManageMessages) {
    items.push({
      label: message.pinned ? t("chat.unpin") : t("chat.pin"),
      action: () => {
        const request = message.pinned
          ? session.unpinMessage(message.channelId, message.id)
          : session.pinMessage(message.channelId, message.id);
        void request.catch((error: unknown) => {
          notifications.showToast({
            title: "space",
            channelName: "",
            body: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });
  }
  // Discussions: one thread per message — open the existing one, or open the LAZY-CREATE
  // draft ("Start discussion" creates NOTHING server-side; the first reply materialises
  // the thread, conflicts are resolved server-side by reuse). Server TEXT channels only
  // (not DMs, not inside a thread — the parent must be a TEXT channel).
  if (extra.canStartDiscussion) {
    const existing = session.discussionsStore.byOrigin(message.id);
    if (existing !== undefined) {
      items.push({ label: t("chat.openDiscussion"), action: () => openDiscussion(existing) });
    } else {
      items.push({
        label: t("chat.startDiscussion"),
        action: () => openDraftDiscussion({ channelId: message.channelId, messageId: message.id }),
      });
    }
  }
  items.push({ separator: true });
  if ((message.content?.length ?? 0) > 0) {
    items.push({ label: t("chat.copyText"), action: () => void navigator.clipboard.writeText(message.content ?? "").catch(() => undefined) });
  }
  if (message.authorUsername === ownUsername) {
    items.push({ label: t("chat.edit"), action: () => actions.beginEdit(message) });
  }
  if (!actions.selectionMode) {
    items.push({ label: t("chat.selectMessages"), action: extra.beginSelection });
  }
  if (message.authorUsername === ownUsername || canManageMessages) {
    items.push({ label: t("common.delete"), danger: true, action: extra.confirmDelete });
  }
  return collapseMenuSeparators(items);
}

/** Conditional items (no ADD_REACTIONS, DMs, someone else's message…) must never
 *  leave a divider stranded at the edges or doubled mid-list. */
function collapseMenuSeparators(items: ContextMenuItem[]): ContextMenuItem[] {
  const collapsed: ContextMenuItem[] = [];
  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];
    if (item.separator && (collapsed.length === 0 || previous === undefined || previous.separator)) {
      continue;
    }
    collapsed.push(item);
  }
  const tail = collapsed[collapsed.length - 1];
  if (tail !== undefined && tail.separator) {
    collapsed.pop();
  }
  return collapsed;
}

// ---------------------------------------------------------------------------
// Message list (VirtualList + pagination + jump + unread divider)
// ---------------------------------------------------------------------------

interface MessageListProps {
  session: ConnectionSession;
  channel: Channel;
  messages: readonly Message[];
  /** A just-clicked search result in THIS channel: center the around window on it
   *  (flash + scroll), then the field is consumed. Null while no jump is pending. */
  aroundTarget: number | null;
  actions: ChatActions;
  authorColor(username: string): string | null;
  editing: Message | null;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
  onReactedBy(state: { x: number; y: number; names: readonly string[] }): void;
}

// Memoized: ChatPane re-renders on every store/UI event it subscribes to (a
// discussion bump server-wide, a roster push, menu/picker/reply state flips) —
// with memo, those stop cascading into the visible window's rows whenever the
// list's own props are unchanged.
const MessageList = memo(function MessageList(props: MessageListProps): React.JSX.Element {
  const { session, channel, messages, aroundTarget, actions, editing } = props;
  const t = useT();
  const listRef = useRef<VirtualListHandle | null>(null);
  const nearBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const hasOlderRef = useRef(true);
  const pendingJumpRef = useRef<number | null>(null);
  const firstLayoutRef = useRef(true);
  // The around window's downward end: true while an id-unknown gap sits between the
  // window's last message and the live tail (the search jump opened mid-history).
  const belowEndRef = useRef(false);
  // One-shot: the batch that LANDED the tail (the short page closing the around
  // gap) must not raise the NEW divider — the reader just scrolled through that
  // history by hand, it is read, not unread (live report 2026-10-27: the whole
  // first downward page lit up as NEW the moment the pill vanished). Set on the
  // around→plain transition, consumed by the growth effect below; a no-growth
  // pass expires it so a stale flag can never swallow a REAL divider later.
  const tailLandingSuppressRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [jumpToPresent, setJumpToPresent] = useState(false);
  // The scroll-to-latest chevron's "reader is away from the newest message"
  // half — the OTHER half is jumpToPresent (a search-jump window with a gap
  // below: the reader can sit at the loaded list's bottom edge and still be
  // far from the chat's real end).
  const [scrolledUp, setScrolledUp] = useState(false);
  const [dividerReadId, setDividerReadId] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [beginReached, setBeginReached] = useState(false);
  // One settling-jump ladder at a time — a new jump cancels the previous
  // ladder's re-assertions (two ladders would fight over the viewport).
  const settlingJumpCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => settlingJumpCancelRef.current?.(), []);

  // Row keys are scoped by the server RECORD. Message ids are per-database
  // sequences — two servers' ids collide head-on — and the virtualizer
  // SURVIVES the session swap (a switch promotes another session without
  // remounting this tree), keeping its measured-height cache keyed by row
  // key (the cache WINS over the estimate in tanstack's core). With a bare
  // id, the new server's rows adopted the OLD server's heights; every row
  // then re-measured to its real height as it scrolled into view, shifting
  // content under the reader (the cross-server scroll jump, live report
  // 2026-10-19).
  const rowKeyOf = useCallback(
    (messageId: number) => `${session.recordId}:${messageId}`,
    [session.recordId],
  );

  // oak's divider lifecycle (MainController, Java-ported): it appears above the
  // first unread (channel open, or a live batch while the user is away) and is
  // dismissed ONLY by the pinned-bottom timer — 1.5s, RESTARTED by every
  // scroll/click/keypress while pinned, CANCELLED by scrolling away. No
  // TTL-at-open, no instant clear on the auto-scroll (that made it flash for a
  // frame, live report).
  const dismissTimerRef = useRef(0);
  const cancelDividerDismiss = () => {
    if (dismissTimerRef.current !== 0) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = 0;
    }
  };
  const scheduleDividerDismiss = () => {
    cancelDividerDismiss();
    if (!nearBottomRef.current) {
      return; // scrolled away — the divider STAYS until the user comes back
    }
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = 0;
      setDividerReadId(null);
    }, 1500);
  };
  useEffect(() => cancelDividerDismiss, []);

  // While the divider is up, ANY user activity restarts the dismiss countdown —
  // the same restart-on-scroll/click contract oak's markReadDelay has.
  useEffect(() => {
    if (dividerReadId === null) {
      return;
    }
    const onActivity = () => scheduleDividerDismiss();
    window.addEventListener("wheel", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dividerReadId]);

  // Snapshot the unread divider at open (before the ack moves the pointer).
  useEffect(() => {
    const lastRead = session.readStateStore.get(channel.id).lastReadMessageId;
    setDividerReadId(lastRead);
    firstLayoutRef.current = true;
    hasOlderRef.current = true;
    setBeginReached(false);
    belowEndRef.current = false;
    setJumpToPresent(false);
    setScrolledUp(false);
    tailLandingSuppressRef.current = false;
    // A back-fill jump belongs to the list that armed it — after a server
    // switch the same numeric id denotes a DIFFERENT message (the same
    // id-collision class the scoped row keys close).
    pendingJumpRef.current = null;
  }, [channel.id, session]);

  // The auto catch-up may heal the window while the user is looking at it (the
  // gap below is paginated through — the list is contiguous with the tail
  // again): the "gap" affordance goes away, what remains is ordinary scrolling.
  // ARMING is symmetric: when the jump target was ALREADY in the loaded list,
  // the consumption effect below runs BEFORE the around snapshot lands and
  // reads a not-yet-armed flag — the store flag is the authority, so it arms
  // here too (live report: after a search jump to a recent message, scrolling
  // back down loaded nothing and the "Jump to present" pill never showed).
  const aroundActive = useStore(session.messageStore, (store) => store.isAroundWithoutTail(channel.id));
  useEffect(() => {
    if (aroundActive) {
      if (!belowEndRef.current) {
        belowEndRef.current = true;
        setJumpToPresent(true);
      }
    } else if (belowEndRef.current) {
      belowEndRef.current = false;
      // The PILL outlives the data gap: it dismisses only when the reader
      // reaches the bottom (onBottomProximity) or clicks it — the gap closing
      // a page early must not strand the reader without the jump affordance.
      // The flag only clears together with a batch landing the tail — mark
      // that batch as "walked-through history" for the growth effect.
      tailLandingSuppressRef.current = true;
    }
  }, [aroundActive]);

  // The search jump: once the around window ARRIVES (the target id is in the list),
  // center on it, flash it, and consume the appStore field. Declared BEFORE the
  // first-layout effect so it claims the layout (firstLayoutRef=false) — otherwise
  // the divider/bottom open would fight the centering scroll. No cleanup: the
  // highlight TTL timer is idempotent, and the consumption patch re-triggers this
  // effect (aroundTarget → null) where a cleanup would kill the flash mid-flight.
  useEffect(() => {
    if (aroundTarget === null || !messages.some((message) => message.id === aroundTarget)) {
      return;
    }
    // The around window REPLACED the list, so any "begin of channel" latch
    // from the list it replaced is void — a REPEATED jump (re-armed on an
    // already-around channel: the store flag never transitions, it is set
    // unconditionally) must resurrect scroll-up even when the reader had
    // paged an earlier window all the way to the real top (live report
    // 2026-11-03: pin 4/4 → scrolled to the begin, pin 3/4 → same, pin 4/4
    // again → older messages never loaded).
    hasOlderRef.current = true;
    setBeginReached(false);
    appStore.patch({ activeAround: null }); // consumed — a later channel re-entry must not re-jump
    firstLayoutRef.current = false; // the window IS the layout — no divider/bottom open
    const around = session.messageStore.isAroundWithoutTail(channel.id);
    belowEndRef.current = around;
    setJumpToPresent(around);
    settlingJumpCancelRef.current?.();
    settlingJumpCancelRef.current = scheduleSettlingJump(listRef, rowKeyOf(aroundTarget), () => {
      // Re-flash with every re-assertion: the row may only ENTER the viewport
      // on a late attempt, when the original highlight is long gone.
      setHighlightId(aroundTarget);
      window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aroundTarget, messages]);

  // oak's BeginOfChannel latch: a short initial page IS the whole history — the
  // marker rides above everything without a guaranteed-empty pagination probe.
  // NEVER for an around window: it is legitimately short (cut at the BOTTOM
  // when the jump target sits near the tail, or at the top near the begin) and
  // mistaking that cut for "all of history" killed scroll-up after a jump
  // (live report 2026-11-03). The real begin latches in loadOlder on the first
  // short RAW page — one probe only when the reader actually reaches the top.
  useEffect(() => {
    if (!beginReached && hasOlderRef.current && !loadingOlderRef.current
      && !aroundActive
      && messages.length > 0 && messages.length < HISTORY_PAGE) {
      hasOlderRef.current = false;
      setBeginReached(true);
    }
  }, [messages, beginReached, aroundActive]);

  // First layout: open on the divider when unread exists, else on the bottom.
  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    if (!firstLayoutRef.current) {
      return;
    }
    firstLayoutRef.current = false;
    if (dividerReadId !== null) {
      window.setTimeout(() => listRef.current?.scrollToBottom(), 30); // let heights settle, then…
      window.setTimeout(() => {
        const index = messages.findIndex((message) => message.id > dividerReadId
          && message.authorUsername !== session.username());
        const firstUnread = index > 0 ? messages[index] : undefined;
        if (firstUnread !== undefined) {
          listRef.current?.scrollToKey(rowKeyOf(firstUnread.id), "center");
        }
      }, 60);
    } else {
      window.setTimeout(() => listRef.current?.scrollToBottom(), 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length > 0]);

  // New messages stick to the bottom while the user is there. A batch arriving
  // while the user is AWAY (scrolled up, or the window unfocused) raises the
  // NEW divider above it. A batch the user IS watching (pinned + window
  // focused) is READ on the spot. One's OWN batch (the send echo) is read
  // UNCONDITIONALLY — your own message can never be "new messages" for you
  // (live report: a new-group own message still raised the divider when the
  // scroll-proximity flag flipped false for a frame during the re-layout).
  const messageCountRef = useRef(messages.length);
  const previousTailRef = useRef<number | null>(null);
  const lastStickLogAtRef = useRef(0);
  useEffect(() => {
    const grew = messages.length > messageCountRef.current;
    if (!grew) {
      tailLandingSuppressRef.current = false; // expire stale suppression
    }
    const pinned = nearBottomRef.current;
    const watching = pinned && document.hasFocus();
    const ownBatch = previousTailRef.current !== null
      && messages.filter((message) => message.id > previousTailRef.current!)
        .every((message) => message.authorUsername === session.username());
    // While an around window is paginating DOWN, the "new" rows below are OLD
    // messages fetched on demand — not unread arrivals. No divider raise, no
    // ack, and NO stick-to-bottom either: revealed history grows BELOW the
    // anchored reader (the snap used to yank the reader to each page's end and
    // could dead-end at the exact bottom, where wheel-down makes no scroll
    // event at all — "the latest messages never load"; live report 2026-10-27.
    // The page chain is driven by loadNewer itself now).
    if (grew && tailLandingSuppressRef.current) {
      tailLandingSuppressRef.current = false; // the tail-landing batch: history walked through by hand
    } else if (grew && previousTailRef.current !== null && !watching && !ownBatch && !belowEndRef.current) {
      setDividerReadId(previousTailRef.current);
    }
    // Server ids only — the optimistic tail (negative ids) must not become the
    // unread divider's anchor or the own-batch filter's threshold.
    previousTailRef.current = lastServerMessageId(messages);
    messageCountRef.current = messages.length;
    if (grew && pinned && !belowEndRef.current) {
      // Diagnostics marker (paced): if the thumb bounce is THIS call fighting
      // the departing reader, space.log shows it next to the drift lines —
      // one log, both suspects, no guessing.
      const now = performance.now();
      if (now - lastStickLogAtRef.current > 2000) {
        lastStickLogAtRef.current = now;
        log.info("vscroll", "stick-to-bottom: scrollToBottom on batch arrival (reader pinned)");
      }
      listRef.current?.scrollToBottom();
      setJumpToPresent(false); // pinned on the LIVE bottom — the jump affordance is spent
      setScrolledUp(false);
    }
    if (grew && (watching || ownBatch) && !belowEndRef.current) {
      ackActiveChannel();
    }
  }, [messages]);

  // Warm the learned-dimensions cache for legacy (no-wire-dims) media BEFORE
  // the reader scrolls into those rows: a cold legacy image mounts with a
  // fallback box and re-measures after the decode — the virtualizer's
  // first-measure compensation then nudges scrollTop on every such row,
  // which the user feels as the thumb bouncing through image-heavy history
  // (live report 2026-10-19). Armed on channel open and on every history
  // prepend (the fresh cold rows arrive ABOVE); tail growth never re-arms.
  const dimsWarmupArmRef = useRef<{ channelKey: string; firstId: number } | null>(null);
  useEffect(() => {
    const first = messages[0];
    if (first === undefined) {
      return;
    }
    const channelKey = `${session.recordId}:${channel.id}`;
    const arm = dimsWarmupArmRef.current;
    if (arm !== null && arm.channelKey === channelKey && first.id >= arm.firstId) {
      return;
    }
    dimsWarmupArmRef.current = { channelKey, firstId: first.id };
    warmLegacyAttachmentDims(messages, session.attachmentCache);
  }, [messages, channel.id, session.recordId, session.attachmentCache]);

  useEffect(() => {
    const onFocus = () => {
      if (nearBottomRef.current) {
        scheduleDividerDismiss(); // focus while pinned restarts the countdown
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back-filled jump: scroll + flash when the target arrives.
  useEffect(() => {
    const target = pendingJumpRef.current;
    if (target === null || !messages.some((message) => message.id === target)) {
      return;
    }
    pendingJumpRef.current = null;
    settlingJumpCancelRef.current?.();
    settlingJumpCancelRef.current = scheduleSettlingJump(listRef, rowKeyOf(target), () => {
      setHighlightId(target);
      window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
    });
  }, [messages]);

  const loadOlder = () => {
    if (loadingOlderRef.current || !hasOlderRef.current || messages.length === 0) {
      return;
    }
    loadingOlderRef.current = true;
    void (async () => {
      try {
        let rawPageLength = await session.loadOlder(channel.id, messages[0]!.id);
        // Page alignment (live report, chat 4444): a pagination boundary that CUTS
        // a group in half made the group "redraw" on every back-fill — its head
        // flipped to a continuation as older same-author messages arrived above.
        // Keep fetching (capped) while the top of the list is mid-group, so a
        // boundary always lands on an author/time change: groups load WHOLE.
        for (let alignmentPage = 0; alignmentPage < 3; alignmentPage += 1) {
          if (rawPageLength < HISTORY_PAGE) {
            break; // history exhausted — nothing above can extend the group anyway
          }
          const list = session.messageStore.listFor(channel.id);
          const asGroupable = (message: Message): GroupableMessage => ({
            id: message.id,
            authorUsername: message.authorUsername,
            createdAtEpochMs: toEpochMs(message.createdAt),
          });
          if (list.length < 2 || !continuesGroup(asGroupable(list[1]!), asGroupable(list[0]!))) {
            break; // the top already sits on a group boundary
          }
          rawPageLength = await session.loadOlder(channel.id, list[0]!.id);
        }
        if (rawPageLength < HISTORY_PAGE) {
          hasOlderRef.current = false; // end of history latches on the RAW page
          setBeginReached(true);
        }
      } catch {
        // next near-top pass retries
      } finally {
        loadingOlderRef.current = false;
      }
    })();
  };

  /** Downward pagination away from an around window (towards the live tail). A short
   *  RAW page = the gap is closed: the list is contiguous again, so the around flag
   *  clears (live appends + the reconnect heal resume) and the ack becomes real. */
  const loadNewer = () => {
    if (loadingNewerRef.current || !belowEndRef.current || messages.length === 0) {
      return;
    }
    loadingNewerRef.current = true;
    void (async () => {
      try {
        // The cursor comes from the STORE, not the messages prop: the chained
        // call below may fire from a timeout holding a pre-render closure, and
        // a stale prop cursor would refetch the same page forever (jumpTo
        // precedent). Server id only — an optimistic temp row (negative id)
        // parked at the tail would send an invalid afterId cursor.
        const lastId = lastServerMessageId(session.messageStore.listFor(channel.id));
        if (lastId === null) {
          return;
        }
        const raw = await session.loadNewer(channel.id, lastId);
        if (raw < NEWER_PAGE) {
          belowEndRef.current = false;
          // jumpToPresent deliberately STAYS: the pill is positional (until
          // the reader reaches the bottom), not gap-driven.
          session.messageStore.markTailReached(channel.id);
          if (nearBottomRef.current && document.hasFocus()) {
            ackActiveChannel(); // contiguous tail now — the ack is finally true
          }
        } else if (nearBottomRef.current) {
          // Chain without waiting for a scroll event: the reader stayed at the
          // revealed edge, so keep paging until they pull away or the tail
          // lands. (Relying on bottom-proximity alone dead-ends when the
          // reader sits at the EXACT bottom — wheel-down there produces no
          // scroll event, so the edge trigger never re-fires.)
          window.setTimeout(() => loadNewerRef.current(), 50);
        }
      } catch {
        // next near-bottom pass retries
      } finally {
        loadingNewerRef.current = false;
      }
    })();
  };
  // Latest-closure ref: the chain above must call the CURRENT loadNewer (with
  // a fresh nearBottomRef-aware closure), not the one captured at arm time.
  const loadNewerRef = useRef(loadNewer);
  loadNewerRef.current = loadNewer;

  /** "Jump to present": discard the window, refetch the newest page as the plain
   *  contiguous tail and land on the bottom. */
  const jumpToPresentNow = () => {
    void session.reloadTail(channel.id)
      .then(() => {
        belowEndRef.current = false;
        setJumpToPresent(false);
        hasOlderRef.current = true;
        setBeginReached(false);
        firstLayoutRef.current = false; // the explicit bottom scroll below is the layout
        window.setTimeout(() => listRef.current?.scrollToBottom(), 30);
      })
      .catch((error: unknown) => {
        log.warn("chat", `"jump to present" reload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  // jumpTo reads the STORE for its fast path (fresher than the messages prop —
  // the same source the backfill loop below reads), which keeps the callback
  // free of the messages dep: its identity survives every new message.
  const jumpTo = useCallback((messageId: number) => {
    if (session.messageStore.listFor(channel.id).some((message) => message.id === messageId)) {
      settlingJumpCancelRef.current?.();
      settlingJumpCancelRef.current = scheduleSettlingJump(listRef, rowKeyOf(messageId), () => {
        setHighlightId(messageId);
        window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
      });
      return;
    }
    pendingJumpRef.current = messageId;
    void (async () => {
      let loaded = 0;
      while (
        !session.messageStore.listFor(channel.id).some((message) => message.id === messageId)
        && loaded < MAX_JUMP_BACKFILL
      ) {
        const list = session.messageStore.listFor(channel.id);
        if (list.length === 0) {
          pendingJumpRef.current = null;
          return;
        }
        const raw = await session.loadOlder(channel.id, list[0]!.id);
        if (raw < HISTORY_PAGE) {
          pendingJumpRef.current = null; // history exhausted — the quote is dangling
          return;
        }
        loaded += raw;
      }
      if (!session.messageStore.listFor(channel.id).some((message) => message.id === messageId)) {
        pendingJumpRef.current = null; // the backfill cap gave up — say so (oak's toast)
        notifications.showToast({ title: "space", channelName: "", body: t("chat.tooFarBack") });
      }
    })().catch((error: unknown) => {
      log.warn("chat", `jump-to backfill (message ${messageId}) failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [channel, session]);
  const wiredActions = useMemo<ChatActions>(() => ({ ...actions, jumpTo }), [actions, jumpTo]);

  const groupStarts = useMemo(() => computeGroupStarts(messages.map((message): GroupableMessage => ({
    id: message.id,
    authorUsername: message.authorUsername,
    createdAtEpochMs: toEpochMs(message.createdAt),
  }))), [messages]);
  // Continuation-aware estimator: the estimate must know whether THIS row is a
  // group head (30px base) or a continuation (~22px reality) — see estimateRowHeight.
  const startById = useMemo(
    () => new Map(messages.map((message, index) => [message.id, groupStarts[index] ?? true])),
    [messages, groupStarts],
  );
  // The discussion-tile flag rides the same estimator: rows carrying a thread tile are +24.
  // Keyed on the store's version — the origin-id SET itself is derived (useMemo, never a
  // selector — the infinite-rerender bug class).
  const rowDiscussionsVersion = useStore(session.discussionsStore, (store) => store.version);
  // The jumbo size rides the row ESTIMATE too (not just the render): a changed
  // setting re-sizes both in one frame, so no measure-driven row drift.
  const emojiJumboSize = useStore(settingsStore, (settings) => settings.emojiJumboSize);
  const discussionOriginIds = useMemo(() => {
    void rowDiscussionsVersion; // the mutation key
    const originIds = new Set<number>();
    for (const discussion of session.discussionsStore.forParent(channel.id)) {
      originIds.add(discussion.originMessageId);
    }
    return originIds;
  }, [rowDiscussionsVersion, session, channel.id]);
  const groupedEstimateHeight = useCallback(
    (message: Message): number => estimateRowHeight(message, {
      startsGroup: startById.get(message.id) ?? true,
      hasDiscussionTile: discussionOriginIds.has(message.id),
      jumboEmojiPx: emojiJumboSize,
      // The LIVE attachment width the rows measured — the estimate must equal
      // the first paint or the measurement shifts everything below (the
      // bounce-through-images report, 2026-10-19).
      usableWidth: attachmentUsableWidth(),
      // The MEASURED glyph width of the actual font (canvas metric, cached in
      // glyph-metrics.ts) — the wrap lines stop depending on the 7px guess.
      glyphWidthPx: bodyGlyphWidthPx(),
      knownDimsOf: learnedDims,
    }),
    [startById, discussionOriginIds, emojiJumboSize],
  );

  // Discord/oak rule: your OWN message is never "new" for you — the divider
  // only rides above someone ELSE's first unread message. The pointer below
  // can legitimately sit right under an own message (the send-time ack moves
  // it there), which used to render the divider above the sender's own DM
  // message (live report).
  const dividerIndex = dividerReadId === null
    ? -1
    : messages.findIndex((message) => message.id > dividerReadId && message.authorUsername !== session.username());

  return (
    <>
      <VirtualList
      className="message-list virtual-list"
      ref={listRef}
      items={messages}
      itemKey={(message) => rowKeyOf(message.id)}
      estimateHeight={groupedEstimateHeight}
      onNearTop={loadOlder}
      onUserScrollIntent={(direction) => {
        // The gate below reports one rAF later (paced 250 ms); a batch landing
        // inside that window must not yank the departing reader back to the
        // bottom — un-pin on the very first upward notch (live report 2026-10-19:
        // "scroll to the very bottom, then wheel up — the thumb kept snapping
        // back"; mid-list reading was always smooth).
        if (direction === "up") {
          nearBottomRef.current = false;
        }
      }}
      onBottomProximity={(nearBottom) => {
        nearBottomRef.current = nearBottom;
        setScrolledUp(!nearBottom);
        if (nearBottom) {
          scheduleDividerDismiss(); // back at the bottom → restart the countdown
          // The reader reached the LOADED list's bottom edge. That is the
          // chat's real bottom ONLY without a gap below — during around
          // pagination this same edge fires with belowEnd still armed, and
          // dismissing the jump affordance there is what made the chevron
          // vanish at the first page boundary (live report 2026-10-27).
          if (!belowEndRef.current) {
            setJumpToPresent(false);
          }
          if (belowEndRef.current) {
            loadNewer(); // pinned at the window's lower edge → page towards the tail
          }
        } else {
          cancelDividerDismiss(); // scrolled away — the divider stays put
        }
      }}
      renderItem={(message, index) => (
        <>
          {index === 0 && beginReached ? (
            <div className="begin-marker">{t("chat.beginningOfHistory")}</div>
          ) : null}
          {index === dividerIndex ? (
            <div
              className="new-messages-divider"
              title={t("chat.jumpToFirstUnread")}
              onClick={(event) => {
                event.stopPropagation();
                const firstUnread = messages[dividerIndex];
                if (firstUnread !== undefined) {
                  wiredActions.jumpTo(firstUnread.id);
                }
              }}
            >
              <span>↓ {t("chat.newMessages")} ↓</span>
            </div>
          ) : null}
          <MessageRow
            session={session}
            channel={channel}
            message={message}
            authorColor={props.authorColor}
            startsGroup={groupStarts[index] ?? true}
            editing={editing?.id === message.id}
            highlighted={highlightId === message.id}
            selected={actions.selectionMode && actions.selection.has(message.id)}
            discussion={session.discussionsStore.byOrigin(message.id)}
            actions={wiredActions}
            setEditing={props.setEditing}
            onMenu={props.onMenu}
            onPicker={props.onPicker}
            onReactedBy={props.onReactedBy}
          />
        </>
      )}
      />
      {(scrolledUp || jumpToPresent) && messages.length > 0 ? (
        <button
          className="chat-scroll-down"
          title={t("chat.jumpToLatest")}
          onClick={() => {
            if (belowEndRef.current) {
              // An id-unknown gap sits below — only a tail reload truly lands
              // on the newest message (the old "Jump To Present" behavior).
              jumpToPresentNow();
              return;
            }
            listRef.current?.scrollToBottom();
          }}
        >
          <span className="icon mdi-chevron-down" />
        </button>
      ) : null}
    </>
  );
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface MessageRowProps {
  session: ConnectionSession;
  channel: Channel;
  message: Message;
  authorColor(username: string): string | null;
  startsGroup: boolean;
  editing: boolean;
  highlighted: boolean;
  selected: boolean;
  /** The thread living on THIS message (a tile under the body); undefined = none. A stable
   *  shared row object from the DiscussionsStore — the memoized row re-renders on flip. */
  discussion: Discussion | undefined;
  actions: ChatActions;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
  onReactedBy(state: { x: number; y: number; names: readonly string[] }): void;
}

/** One ":name:" token rendered as an inline catalog image (a fixed em box — zero
 *  layout shift). Falls back to the literal text while the image is not there yet
 *  (no cache hit) or after the emoji was deleted — never a broken <img>.
 *  `large` is Discord's jumbo mode: an emoji-only message renders its tokens
 *  big instead of text-height — the exact size is the reader's own setting
 *  (Settings → Appearance; default 48 = Discord parity). */
function InlineEmoji({ session, name, large = false }: {
  session: ConnectionSession;
  name: string;
  large?: boolean;
}): React.JSX.Element {
  const emoji = useStore(session.emojiStore, (state) => state.byName.get(name) ?? null);
  const jumboSize = useStore(settingsStore, (settings) => settings.emojiJumboSize);
  const imageUrl = useAttachmentImage(
    session,
    emoji !== null && emoji.url !== null ? { key: emoji.key, url: emoji.url } : null,
  );
  if (emoji === null || imageUrl === null) {
    return <span>{`:${name}:`}</span>;
  }
  return (
    <img
      className={large ? "inline-emoji inline-emoji-large" : "inline-emoji"}
      style={large ? { height: `${jumboSize}px` } : undefined}
      src={imageUrl}
      alt={`:${name}:`}
      title={`:${name}:`}
      draggable={false}
    />
  );
}

/**
 * The emoji half of a reaction chip. A built-in slug renders its unicode glyph; a
 * ":name:" token resolves through the LIVE catalog (the phase-1 model: an <img> via the
 * attachment cache) and degrades to the literal ":name:" text when the emoji is gone —
 * the chip itself stays clickable either way, so a dangling reaction can still be
 * lifted off (the server's remove path deliberately skips the catalog check). Hooks
 * run unconditionally — the built-in early return must never skip them.
 */
function ReactionChipLabel({ session, slug }: {
  session: ConnectionSession;
  slug: string;
}): React.JSX.Element {
  const emojiName = customEmojiNameOfReactionSlug(slug);
  const emoji = useStore(
    session.emojiStore,
    (state) => (emojiName !== null ? state.byName.get(emojiName) ?? null : null),
  );
  const imageUrl = useAttachmentImage(
    session,
    emoji !== null && emoji.url !== null ? { key: emoji.key, url: emoji.url } : null,
  );
  if (emojiName === null) {
    return <span>{REACTION_GLYPH_BY_SLUG[slug] ?? slug}</span>;
  }
  if (emoji === null || imageUrl === null) {
    return <span>{`:${emojiName}:`}</span>;
  }
  return (
    <img
      className="reaction-chip-emoji"
      src={imageUrl}
      alt={`:${emojiName}:`}
      title={`:${emojiName}:`}
      draggable={false}
    />
  );
}

/**
 * The sticker block of a message — a big standalone image under the text (Discord's
 * standard sticker render). The ref is the DENORMALIZED copy: when the catalog row is
 * deleted and the swept object's URL dies, the negative cache turns this into a
 * tombstone naming WHAT died (a bare gray box identifies nothing). The render height
 * is FIXED (STICKER_RENDER_PX), so the row's estimate never shifts on decode. */
function InlineSticker({ session, sticker }: {
  session: ConnectionSession;
  sticker: StickerRef;
}): React.JSX.Element {
  const imageUrl = useAttachmentImage(session, sticker.url !== null ? sticker : null);
  if (imageUrl === null) {
    return (
      <span className="message-sticker-dead" title={sticker.name}>
        <span className="icon mdi-sticker" />
        <span className="message-sticker-dead-name">{sticker.name}</span>
      </span>
    );
  }
  return (
    <img
      className="message-sticker"
      src={imageUrl}
      alt={`:${sticker.name}:`}
      title={`:${sticker.name}:`}
      draggable={false}
    />
  );
}

/** A hidden ||spoiler|| span — a click toggles the reveal (Discord's behavior);
 *  stopPropagation keeps the row's own selection-click quiet. */
function SpoilerSpan({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={"fmt-spoiler" + (revealed ? " revealed" : "")}
      onClick={(event) => {
        event.stopPropagation();
        setRevealed((current) => !current);
      }}
    >{children}</span>
  );
}

/** Context-specific segment pieces: the walk below is shared, while mentions,
 *  links and custom emojis depend on where the segments render (the row has the
 *  session; the quote preview must stay flat — see FLAT_SEGMENT_DECORATORS). */
type SegmentDecorators = {
  mention: (segment: Extract<MessageSegment, { kind: "mention" }>, key: string) => React.ReactNode;
  link: (segment: Extract<MessageSegment, { kind: "link" }>, key: string) => React.ReactNode;
  emoji: (segment: Extract<MessageSegment, { kind: "emoji" }>, key: string) => React.ReactNode;
};

/** The quote preview's decorators: everything renders as PLAIN TEXT. The preview
 *  string is server-truncated at 100 chars — a link segment cut mid-URL must not
 *  become a clickable <a> (it would open a dead page). */
const FLAT_SEGMENT_DECORATORS: SegmentDecorators = {
  mention: (segment, key) => <span key={key}>{segment.text}</span>,
  link: (segment, key) => <span key={key}>{segment.text}</span>,
  emoji: (segment, key) => <span key={key}>{segment.text}</span>,
};

/** Recursive render of a segment list — the formatting pass nests children
 *  inside "formatted" nodes, so the row's flat map became a walk. Pure JSX, no
 *  HTML strings anywhere (the project's no-innerHTML discipline). */
function renderMessageSegments(
  segments: readonly MessageSegment[],
  decorators: SegmentDecorators,
  keyPrefix: string,
): React.ReactNode[] {
  return segments.map((segment, segmentIndex) => {
    const key = `${keyPrefix}${segmentIndex}`;
    switch (segment.kind) {
      case "text":
        return <span key={key}>{segment.text}</span>;
      case "mention":
        return decorators.mention(segment, key);
      case "link":
        return decorators.link(segment, key);
      case "emoji":
        return decorators.emoji(segment, key);
      case "formatted":
        if (segment.format === "spoiler") {
          return <SpoilerSpan key={key}>{renderMessageSegments(segment.children, decorators, `${key}-`)}</SpoilerSpan>;
        }
        if (segment.format === "code") {
          // The parser keeps a code span TERMINAL (exactly one text child) —
          // render that string directly, no nested span.
          const inner = segment.children.length === 1 && segment.children[0]!.kind === "text"
            ? segment.children[0]!.text
            : renderMessageSegments(segment.children, decorators, `${key}-`);
          return <code key={key} className="fmt-code">{inner}</code>;
        }
        return <span key={key} className={`fmt-${segment.format}`}>{renderMessageSegments(segment.children, decorators, `${key}-`)}</span>;
    }
  });
}

/** The ROW's decorators (also the composer's preview mode): mentions highlight,
 *  links open the system browser, custom emojis resolve through the catalog. */
function messageDecorators(session: ConnectionSession, largeEmojis: boolean): SegmentDecorators {
  return {
    mention: (segment, key) => <span key={key} className="mention">{segment.text}</span>,
    link: (segment, key) => (
      <a
        key={key}
        className="body-link"
        href={segment.url}
        draggable={false}
        onClick={(event) => {
          event.preventDefault(); // the app never navigates — the system browser opens
          void window.spaceMedia?.openExternal(segment.url);
        }}
      >
        {segment.text}
      </a>
    ),
    emoji: (segment, key) => <InlineEmoji key={key} session={session} name={segment.name} large={largeEmojis} />,
  };
}

/**
 * Memoized: the VirtualList recomputes its window on every scroll frame, which
 * re-runs renderItem for the whole visible window — with memo, rows whose props
 * are unchanged (the overwhelming case while scrolling) skip re-rendering
 * entirely; only rows entering/leaving the window actually mount/unmount.
 */
const MessageRow = memo(function MessageRow(props: MessageRowProps): React.JSX.Element {
  const { session, channel, message, startsGroup, editing, highlighted, selected, actions } = props;
  const t = useT();
  const [draft, setDraft] = useState(message.content ?? "");
  /** Image keys marked for removal in the editor (oak's markedAttachmentKeys). */
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(new Set());
  // Subscribed (not read-once): the relative-dates toggle must repaint every
  // stamp the moment it is committed (oak's onApplied → messageList.refresh()).
  const relativeDates = useStore(settingsStore, (settings) => settings.relativeDates);
  // The rename model: names render through the live roster (a /topic/users push
  // repaints every author at once); the username never shows.
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const nameOf = (username: string): string => displayNameOf(rosterUsers, username);
  // Custom emojis resolve through the LIVE catalog: an upload/delete republished by
  // /topic/emojis must repaint already-mounted (memoized) rows — the row owns the
  // name-set subscription, the token lookup happens per segment in InlineEmoji.
  const emojiNames = useStore(session.emojiStore, (state) => state.names);
  // Segmentation is memoized: the regex pass and the jumbo/preview derivations
  // run only when THIS row's message (store identity — edits/reactions replace
  // the object) or the emoji catalog actually changes, not on every parent render.
  const segmented = useMemo(() => {
    const segments = segmentMessageContent(message.content, message.mentions, emojiNames);
    return { segments, emojiOnly: isEmojiOnlyMessage(segments) };
  }, [message, emojiNames]);
  const previewUrl = useMemo(() => firstHttpUrl(message.content), [message]); // oak: only the FIRST link gets a card

  useEffect(() => {
    setDraft(message.content ?? "");
    setRemovedKeys(new Set());
  }, [message.id, message.content]);

  const toggleRemovedKey = (key: string): void => {
    setRemovedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const commitEdit = () => {
    const trimmed = draft.trim();
    const attachmentChange = removedKeys.size > 0;
    const remaining = message.attachments.filter((attachment) => !removedKeys.has(attachment.key));
    // oak's guards: a blank that guts the message (no text AND no attachment
    // left) and a no-op edit (text unchanged, nothing marked) cancel silently.
    if ((trimmed.length === 0 && remaining.length === 0)
      || (trimmed === (message.content ?? "") && !attachmentChange)) {
      props.setEditing(null);
      return;
    }
    void session.editMessage(channel.id, message.id, trimmed, attachmentChange
      ? remaining.map((attachment) => ({
        key: attachment.key,
        fileName: attachment.fileName,
        thumbnailKey: attachment.thumbnailKey,
        durationMillis: attachment.durationMillis,
      }))
      : undefined).catch((error: unknown) => {
      // a rejected edit just returns the OLD text in place — without this line the
      // failure looks like the editor ignored the input (logging round, 2026-10-06).
      log.warn("chat", `edit message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    props.setEditing(null);
  };

  // oak's canAddReactions: DM participants always may; server channels need ADD_REACTIONS.
  const dmContext = channel.type === "DM" || channel.type === "GROUP_DM";
  const canReact = dmContext || session.permissionStore.can("ADD_REACTIONS");
  // Discord's pin gate (the context-menu item's mirror): MANAGE_MESSAGES on
  // server channels, ANY participant in a DM — the server 403s stay the authority.
  const canPin = dmContext || session.permissionStore.can("MANAGE_MESSAGES");

  const body = editing ? (
    <>
      <textarea
        className="inline-editor"
        autoFocus
        spellCheck={true}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitEdit}
        onKeyDown={(event) => {
        // Same settings-owned Enter semantics as the composer (M7).
        const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey;
        const ctrlEnter = event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey;
        const shiftEnter = event.key === "Enter" && event.shiftKey && !event.altKey;
        const commitOnThisEnter = settingsStore.getSnapshot().ctrlEnterSends ? ctrlEnter : plainEnter;
        const newlineOnThisEnter = settingsStore.getSnapshot().ctrlEnterSends ? plainEnter || shiftEnter : ctrlEnter || shiftEnter;
        if (commitOnThisEnter) {
          event.preventDefault();
          commitEdit();
        } else if (newlineOnThisEnter) {
          event.preventDefault();
          const textarea = event.currentTarget;
          textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
          setDraft(textarea.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.setEditing(null);
        }
      }}
      />
      {/* oak's applyEditHint ladder: the base keys, the removal affordance while
          images exist, and the pending-removal count once something is marked. */}
      <div className="inline-editor-hint">
        {removedKeys.size > 0
          ? t("chat.editHintRemoving", { count: removedKeys.size })
          : message.attachments.some((attachment) => isImageFile(attachment.fileName))
            ? t("chat.editHintWithImages")
            : t("chat.editHint")}
      </div>
    </>
  ) : (
    <div className="message-content">
      {renderMessageSegments(segmented.segments, messageDecorators(session, segmented.emojiOnly), "")}
      {message.editedAt !== null ? <span className="message-edited">{t("chat.edited")}</span> : null}
    </div>
  );
  const attachmentView = (
    <AttachmentView
      session={session}
      message={message}
      onForwardBegin={editing === null ? () => actions.beginForward([message]) : undefined}
      removal={editing ? { markedKeys: removedKeys, toggle: toggleRemovedKey } : undefined}
    />
  );

  return (
    <div
      className={"message-row"
        + (startsGroup ? " head" : " continuation")
        + (highlighted ? " highlighted" : "")
        + (selected ? " selected" : "")}
      onClick={() => {
        if (actions.selectionMode && message.id >= 0) {
          actions.toggleSelected(message.id);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // A pending optimistic row has no actions (its POST cannot be cancelled
        // and the message does not exist server-side); a FAILED one opens the
        // Retry/Remove menu (messageMenuItems returns exactly those entries).
        if (!actions.selectionMode && !(message.id < 0 && message.delivery !== "failed")) {
          props.onMenu({ message, x: event.clientX, y: event.clientY });
        }
      }}
    >
      {/* oak's hover cluster, right to left: [react][reply][forward][pin] — the
          react button hugs the scrollbar clearance; pin sits leftmost (the pin
          gate mirrors the context-menu item). Never on an optimistic temp row:
          every action here needs a real message. */}
      {!actions.selectionMode && message.id >= 0 ? (
        <div className="message-hover-buttons">
          {canPin ? (
            <button
              className="hover-button"
              title={message.pinned ? t("chat.unpin") : t("chat.pin")}
              onClick={(event) => {
                event.stopPropagation();
                const request = message.pinned
                  ? session.unpinMessage(message.channelId, message.id)
                  : session.pinMessage(message.channelId, message.id);
                void request.catch((error: unknown) => {
                  notifications.showToast({
                    title: "space",
                    channelName: "",
                    body: error instanceof Error ? error.message : String(error),
                  });
                });
              }}
            >
              <span className={"icon " + (message.pinned ? "mdi-pin-off" : "mdi-pin")} />
            </button>
          ) : null}
          <button
            className="hover-button"
            title={t("chat.forwardVerb")}
            onClick={(event) => {
              event.stopPropagation();
              actions.beginForward([message]);
            }}
          >
            <span className="icon mdi-forward" />
          </button>
          <button
            className="hover-button"
            title={t("chat.reply")}
            onClick={(event) => {
              event.stopPropagation();
              actions.setReplyTo(message);
            }}
          >
            <span className="icon mdi-reply" />
          </button>
          {canReact ? (
            <button
              className="hover-button"
              title={t("chat.addReactionHover")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                props.onPicker({ message, x: rect.left, y: rect.bottom });
              }}
            >
              <span className="icon mdi-emoticon" />
            </button>
          ) : null}
        </div>
      ) : null}
      {startsGroup ? (
        <Avatar session={session} username={message.authorUsername} size={40} />
      ) : (
        <div className="message-gutter">{formatTimeOfDay(toEpochMs(message.createdAt))}</div>
      )}
      <div className="message-body">
        {startsGroup ? (
          <div className="message-meta">
            <span className="message-author" style={{ color: props.authorColor(message.authorUsername) ?? undefined }}>{nameOf(message.authorUsername)}</span>
            <span className="message-time">{formatHeaderStamp(toEpochMs(message.createdAt), Date.now(), relativeDates, currentLang())}</span>
            {message.delivery === "failed" ? (
              // The optimistic send's ONLY visible state (user decision: no
              // "sending" marker) — Discord's red retry glyph on the row.
              <span
                className="message-failed-glyph icon mdi-alert"
                title={t("chat.failedToSend")}
              />
            ) : null}
          </div>
        ) : null}
        {message.forward !== null && !editing ? (
          /* oak: a forward renders the BODY + attachments INSIDE the card — the
             forwarded content reads as the quoted original, not as a plain
             message under a one-line marker. The inline editor keeps the flat order. */
          <ForwardCard forward={message.forward} nameOf={nameOf}>
            {body}
            {attachmentView}
            {previewUrl !== null ? <LinkPreviewCard url={previewUrl} /> : null}
            {message.sticker !== null ? <InlineSticker session={session} sticker={message.sticker} /> : null}
          </ForwardCard>
        ) : (
          <>
            {message.reply !== null
              ? <QuoteCard level={message.reply} depth={0} clickable onJump={actions.jumpTo} nameOf={nameOf} />
              : null}
            {body}
            {previewUrl !== null ? <LinkPreviewCard url={previewUrl} /> : null}
            {attachmentView}
            {message.sticker !== null ? <InlineSticker session={session} sticker={message.sticker} /> : null}
          </>
        )}
        {message.reactions.length > 0 ? (
          <div className="reactions-row">
            {message.reactions.map((summary) => {
              const selfId = session.selfUserId();
              const mine = selfId !== null && summary.userIds.includes(selfId);
              return (
                <button
                  key={summary.reaction}
                  className={"reaction-chip" + (mine ? " mine" : "")}
                  title={summary.usernames.join(", ")}
                  onClick={() => void session.toggleReaction(channel.id, message.id, summary.reaction, mine)
                    .catch((reactionError) => log.warn("reactions", `toggle ${summary.reaction} failed: ${String(reactionError)}`))}
                  onContextMenu={(event) => {
                    // oak's showReactedByMenu: right-click a chip to see who reacted.
                    event.preventDefault();
                    event.stopPropagation();
                    if (!actions.selectionMode) {
                      props.onReactedBy({ x: event.clientX, y: event.clientY, names: summary.usernames });
                    }
                  }}
                >
                  <ReactionChipLabel session={session} slug={summary.reaction} /> {summary.count}
                </button>
              );
            })}
          </div>
        ) : null}
        {props.discussion !== undefined ? (
          <button
            className="message-discussion-tile"
            title={t("chat.openDiscussionOnMessage")}
            onClick={(event) => {
              event.stopPropagation();
              openDiscussion(props.discussion!);
            }}
          >
            <span className="icon mdi-comment-text-outline" />
            {tileReplyLabel(props.discussion)}
          </button>
        ) : null}
      </div>
    </div>
  );
});

/**
 * The origin panel of an OPEN discussion (the pin-card slot): the thread's controls —
 * back to the channel, Follow/Unfollow, and Close (MANAGE_MESSAGES, behind a confirm —
 * closes for everyone). UNDER the tile the origin renders as a FULL chat row (user
 * request 2026-10-27): the snippet tile cannot carry long text, mosaics, stickers or
 * jumbo emoji — the row can, exactly as it appears in the channel; with the row present
 * the tile carries CONTROLS ONLY (user follow-up: the snippet duplicated the row). The
 * frozen snapshot body (author/snippet/time) stays for the rare case of the origin
 * sitting outside the parent's loaded window — no row, no duplicate, just the summary.
 * The DRAFT variant (lazy creation) renders the origin straight from the parent
 * channel's own message list and carries no thread controls — the thread does not
 * exist server-side until the first reply.
 */
function DiscussionOriginPanel({ session, discussion, originFull, onCloseRequest, parentChannel, authorColor, actions, editingMessage, setEditing, onMenu, onPicker, onReactedBy }: {
  session: ConnectionSession;
  discussion: Discussion | null;
  /** The parent-channel Message behind the thread (null when it sits outside
   *  the loaded window — the tile alone remains). For a DRAFT this IS the origin. */
  originFull: Message | null;
  onCloseRequest(): void;
  /** The PARENT channel (the origin message's home — reactions and edits on it
   *  belong there, not to the discussion adapter). */
  parentChannel: Channel;
  authorColor(username: string): string | null;
  actions: ChatActions;
  editingMessage: Message | null;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
  onReactedBy(state: { x: number; y: number; names: readonly string[] }): void;
}): React.JSX.Element | null {
  const t = useT();
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const trackedVersion = useStore(session.discussionsStore, (store) => store.version);
  void trackedVersion; // the row below is read imperatively; this re-renders on flips
  const row = discussion !== null ? session.discussionsStore.byId(discussion.id) ?? discussion : null;
  const canManageMessages = session.permissionStore.can("MANAGE_MESSAGES");
  // The origin as an ordinary chat row under the tile — real actions, so Reply,
  // Edit and reactions work on it right from the thread view.
  const fullRow = originFull !== null ? (
    <div className="discussion-origin-full">
      <MessageRow
        session={session}
        channel={parentChannel}
        message={originFull}
        authorColor={authorColor}
        startsGroup
        editing={editingMessage !== null && editingMessage.id === originFull.id}
        highlighted={false}
        selected={false}
        discussion={undefined}
        actions={actions}
        setEditing={setEditing}
        onMenu={onMenu}
        onPicker={onPicker}
        onReactedBy={onReactedBy}
      />
    </div>
  ) : null;
  if (row === null) {
    // The draft: the origin comes from the parent's own loaded list and always
    // renders as the full row below — the tile carries ONLY the controls (user
    // follow-up 2026-10-27: the snippet duplicated the row). The empty body
    // keeps the layout: back left, the draft tag right.
    if (originFull === null) {
      return null;
    }
    return (
      <>
        <div className="discussion-origin-panel">
          <button className="discussion-origin-back" title={t("chat.backToChannel")} onClick={() => closeDiscussionView()}>
            <span className="icon mdi-arrow-left" />
          </button>
          <div className="discussion-origin-body">
            <div className="discussion-origin-in-chat">{t("chat.discussionInChat", { channel: parentChannel.name })}</div>
          </div>
          <div className="discussion-origin-draft-tag">{t("chat.draftTag")}</div>
        </div>
        {fullRow}
      </>
    );
  }
  const originTime = row.originCreatedAt !== null
    ? formatHeaderStamp(new Date(row.originCreatedAt).getTime(), Date.now(), true, currentLang())
    : null;
  return (
    <>
      <div className="discussion-origin-panel">
        <button
          className="discussion-origin-back"
          title={t("chat.backToChannel")}
          onClick={() => closeDiscussionView()}
        >
          <span className="icon mdi-arrow-left" />
        </button>
        {originFull !== null ? (
          // The full row below carries the message — the tile keeps the
          // controls only (user follow-up 2026-10-27); the empty body carries
          // the parent-chat label and keeps the actions pinned to the right edge.
          <div className="discussion-origin-body">
            <div className="discussion-origin-in-chat">{t("chat.discussionInChat", { channel: parentChannel.name })}</div>
          </div>
        ) : (
          // No full row (the origin sits outside the loaded window) — the
          // frozen snapshot stays as the tile's only content.
          <div className="discussion-origin-body">
            <div className="discussion-origin-author">
              {displayNameOf(rosterUsers, row.originAuthorName)}
              {originTime !== null ? <span className="discussion-origin-time">{originTime}</span> : null}
            </div>
            <div className="discussion-origin-snippet">{row.originSnippet || t("chat.attachmentFallback")}</div>
          </div>
        )}
        <div className="discussion-origin-actions">
          <button
            className="discussion-origin-action"
            title={row.tracked ? t("chat.unfollowDiscussion") : t("chat.followDiscussion")}
            onClick={() => {
              const request = row.tracked
                ? session.untrackDiscussion(row.id)
                : session.trackDiscussion(row.id);
              void request.catch((error: unknown) => {
                notifications.showToast({ title: "space", channelName: "", body: error instanceof Error ? error.message : String(error) });
              });
            }}
          >
            <span className={"icon " + (row.tracked ? "mdi-eye-off-outline" : "mdi-eye-plus-outline")} />
          </button>
          {canManageMessages ? (
            <button
              className="discussion-origin-action danger"
              title={t("chat.closeDiscussionForEveryone")}
              onClick={onCloseRequest}
            >
              <span className="icon mdi-close" />
            </button>
          ) : null}
        </div>
      </div>
      {fullRow}
    </>
  );
}

function QuoteCard({ level, depth, clickable, onJump, nameOf }: {
  level: ReplyInfo;
  depth: number;
  /** Live tree rows jump on click; FROZEN snapshots (inside a forward) never do. */
  clickable: boolean;
  onJump: (messageId: number) => void;
  /** Resolves the RENDERED name (nickname) from the live roster. */
  nameOf: (username: string) => string;
}): React.JSX.Element {
  const t = useT();
  if (level.deleted) {
    return <div className="quote-card deleted">{t("chat.originalDeleted")}</div>;
  }
  return (
    <div className={"quote-card" + (clickable ? " live" : "")}>
      {/* oak's quote level: [reply glyph]["Reply to" bold][nick in palette color] →
          optional nested forward context → nested reply card → one-line preview. */}
      <div
        className="quote-head"
        onClick={clickable ? () => onJump(level.messageId) : undefined}
      >
        <span className="icon mdi-reply" />
        <span className="quote-prefix">{t("chat.replyToPrefix")}</span>
        <span className="quote-author" style={{ color: paletteColor(level.authorUsername) }}>{nameOf(level.authorUsername)}</span>
      </div>
      {level.forward !== null ? <span className="quote-forward">{t("chat.quoteForwardFrom", { name: nameOf(level.forward.authorUsername) })}</span> : null}
      {level.reply !== null && depth < QUOTE_DEPTH_MAX
        ? <QuoteCard level={level.reply} depth={depth + 1} clickable={clickable} onJump={onJump} nameOf={nameOf} />
        : null}
      {/* The preview keeps its markers ("**bold**" arrived as plain text) but now
          renders them: the same segmenter, FLAT decorators (the string is
          server-truncated — a cut URL must stay non-clickable text). */}
      <span className="quote-preview">{renderMessageSegments(segmentMessageContent(level.preview, []), FLAT_SEGMENT_DECORATORS, "")}</span>
    </div>
  );
}

/**
 * oak's forward card: row 1 — [forward glyph]["Forwarded from"][server → #channel]
 * (+ yellow " · unverified" for cross-instance snapshots); row 2 — the ORIGINAL
 * author (palette color) + their timestamp; the frozen quote tree and then the
 * BODY + attachments live INSIDE the card — a forward reads as the quoted original.
 */
function ForwardCard({ forward, children, nameOf }: { forward: ForwardInfo; children: React.ReactNode; nameOf: (username: string) => string }): React.JSX.Element {
  const t = useT();
  // Subscribed like MessageList: a relative-dates toggle repaints the stamp.
  const relativeDates = useStore(settingsStore, (settings) => settings.relativeDates);
  return (
    <div className="forward-card">
      <div className="forward-head">
        <span className="icon mdi-forward" />
        <span className="forward-prefix">{t("chat.forwardedFrom")}</span>
        <span className="forward-origin">{forward.serverName} → #{forward.channelName}</span>
        {!forward.trusted ? <span className="forward-unverified">{` · ${t("chat.unverified")}`}</span> : null}
      </div>
      <div className="forward-author-row">
        <span className="forward-author" style={{ color: paletteColor(forward.authorUsername) }}>{nameOf(forward.authorUsername)}</span>
        <span className="forward-time">{formatHeaderStamp(toEpochMs(forward.createdAt), Date.now(), relativeDates, currentLang())}</span>
      </div>
      {forward.reply !== null ? <QuoteCard level={forward.reply} depth={1} clickable={false} onJump={() => undefined} nameOf={nameOf} /> : null}
      {children}
    </div>
  );
}

/**
 * oak's OG preview card: the FIRST link of a message expands into a page-embed —
 * title + description (≤2 lines) + a 72×72 thumbnail, click opens the system
 * browser. Async with an identity guard (a late callback must not paint a row
 * the virtual list has reused); failures render nothing — the link stays a link.
 */
function LinkPreviewCard({ url }: { url: string }): React.JSX.Element | null {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setThumbnailUrl(null);
    void linkPreviewFor(url).then((result) => {
      if (!cancelled) {
        setPreview(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    const imageUrl = preview?.imageUrl ?? null;
    if (imageUrl === null) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void window.spaceNet?.fetchImage(imageUrl).then((image) => {
      if (cancelled || image === null) {
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([image.data as BlobPart])); // TS: Uint8Array<ArrayBufferLike> ≠ BlobPart
      setThumbnailUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [preview?.imageUrl]);

  if (preview === null || preview === undefined) {
    return null; // loading or a dead/title-less page — nothing until parsed
  }
  return (
    <div
      className="link-preview-card"
      onClick={() => void window.spaceMedia?.openExternal(url)}
    >
      <div className="link-preview-text">
        <span className="link-preview-title">{preview.title}</span>
        {preview.description !== null ? <span className="link-preview-description">{preview.description}</span> : null}
      </div>
      {thumbnailUrl !== null ? <img className="link-preview-thumb" src={thumbnailUrl} alt="" /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** One catalog tile in the composer's emoji popup (a component so the image hook
 *  runs per tile, never inside the grid's map loop). */
function EmojiTile({ session, emoji, onPick }: {
  session: ConnectionSession;
  emoji: CustomEmoji;
  onPick(): void;
}): React.JSX.Element {
  const imageUrl = useAttachmentImage(
    session,
    emoji.url !== null ? { key: emoji.key, url: emoji.url } : null,
  );
  return (
    <button className="emoji-tile" title={`:${emoji.name}:`} onClick={onPick}>
      {imageUrl !== null
        ? <img src={imageUrl} alt={emoji.name} draggable={false} />
        : <span className="emoji-tile-fallback">{emoji.name.slice(0, 2)}</span>}
    </button>
  );
}

/** A built-in unicode emoji tile — the same square as EmojiTile but carrying a glyph
 *  (no catalog row, no ":name:" token). Serves the Built-in sections of BOTH pickers
 *  and the glyph half of the Latest row. */
function BuiltInEmojiTile({ entry, onPick }: {
  entry: BuiltInReaction;
  onPick(): void;
}): React.JSX.Element {
  return (
    <button className="emoji-tile" title={entry.slug} onClick={onPick}>
      <span className="emoji-tile-glyph">{entry.glyph}</span>
    </button>
  );
}

/** One tile of the Latest row (the shared MRU): a catalog image or a built-in glyph,
 *  per the resolved entry — dead customs are dropped by the resolver, so both
 *  payload kinds are always renderable here. */
function RecentExpressionTile({ session, entry, onPick }: {
  session: ConnectionSession;
  entry: RecentExpressionEntry;
  onPick(): void;
}): React.JSX.Element {
  if (entry.emoji !== null) {
    return <EmojiTile session={session} emoji={entry.emoji} onPick={onPick} />;
  }
  return <BuiltInEmojiTile entry={{ slug: entry.slug, glyph: entry.glyph ?? entry.slug }} onPick={onPick} />;
}

/** One catalog tile in the composer's sticker tray (the EmojiTile discipline: the
 *  image hook runs per tile, never inside the grid's map loop). A click SENDS the
 *  sticker — hence the disabled state while a send is in flight. */
function StickerTile({ session, sticker, disabled, onPick }: {
  session: ConnectionSession;
  sticker: Sticker;
  disabled: boolean;
  onPick(): void;
}): React.JSX.Element {
  const imageUrl = useAttachmentImage(
    session,
    sticker.url !== null ? { key: sticker.key, url: sticker.url } : null,
  );
  return (
    <button className="sticker-tile" title={`:${sticker.name}:`} disabled={disabled} onClick={onPick}>
      {imageUrl !== null
        ? <img src={imageUrl} alt={sticker.name} draggable={false} />
        : <span className="sticker-tile-fallback">{sticker.name.slice(0, 2)}</span>}
    </button>
  );
}

function Composer({ session, placeholder, attachEnabled, allowEmptySend, focusSignal, onCancelReply, onPaste, onSend, onSendSticker }: {
  session: ConnectionSession;
  placeholder: string;
  attachEnabled: boolean;
  allowEmptySend: boolean;
  /** Bumped by the parent whenever the caret belongs here (a reply armed, files
   *  staged) — the effect focuses the field at the END of the current draft. */
  focusSignal: number;
  /** oak: ESC in the field cancels an armed reply (consumed so the field keeps focus); null = nothing armed. */
  onCancelReply: (() => void) | null;
  onPaste(files: readonly File[]): void;
  onSend: (content: string) => Promise<void>;
  /** The tray's click-to-send: a sticker-only message, immediately (the text draft
   *  is NOT consumed — Discord's tray behavior). */
  onSendSticker(sticker: Sticker): Promise<void>;
}): React.JSX.Element {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{ token: string; caret: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  // The composer is a single WYSIWYG editor (Lexical, user decision 2026-11-03:
  // the plain/WYSIWYG mode toggle was dropped — two input systems with caret
  // bridges between them were the most fragile part of the whole feature).
  // The editor owns the DOM, the caret and the typing; the flat marker string
  // stays the single MODEL (what goes on the wire): native typing serializes
  // the document into it, external edits (picker inserts, mention
  // substitutions, spell fixes, sends) reload the document from it.
  const editorRootRef = useRef<HTMLDivElement>(null);
  const lexicalEditorRef = useRef<LexicalEditor | null>(null); // created on first mount
  const attachEnabledRef = useRef(attachEnabled); // the paste handler outlives re-renders
  useEffect(() => {
    attachEnabledRef.current = attachEnabled;
  }, [attachEnabled]);
  const textRef = useRef(text); // fresh model text for effect closures that must not re-run
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  // The editor's key handlers live behind refs so the REGISTERED commands
  // (one per mount) always run the freshest render's closures — Lexical sees
  // keydown on the editable BEFORE React's delegated handler, so the
  // keyboarding contract (Enter semantics, the @-popup navigation, Escape)
  // must be answered inside the commands.
  const enterHandlerRef = useRef<(event: KeyboardEvent | null) => void>(() => undefined);
  const escapeHandlerRef = useRef<() => boolean>(() => false);
  const mentionNavigationRef = useRef<(key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab") => boolean>(() => false);
  const mentionUpdateRef = useRef<((value: string, caret: number) => void) | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The placeholder carries the live channel name and can outgrow the field
  // (user report 2026-10-28): clip it to the editor's CONTENT width with an
  // ellipsis instead of the hard clip. A ResizeObserver keeps the clip honest
  // through window resizes (the field is flex: 1 inside the card).
  const [fieldWidthPx, setFieldWidthPx] = useState<number | null>(null);
  useEffect(() => {
    const node = editorRootRef.current;
    if (node === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) {
        setFieldWidthPx(entry.contentRect.width);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const fittedPlaceholder = fieldWidthPx === null
    ? placeholder
    : truncateTextToWidth(placeholder, fieldWidthPx);
  // A reply armed or files staged want the caret HERE, after any existing
  // draft text (the mention-popup rAF refocus idiom, reused).
  useEffect(() => {
    if (focusSignal === 0) {
      return; // the initial value — nothing to focus yet
    }
    requestAnimationFrame(() => {
      const editor = lexicalEditorRef.current;
      if (editor === null || editor.getRootElement() === null) {
        return;
      }
      editor.focus();
      const end = textRef.current.length;
      loadComposerText(editor, textRef.current, { start: end, end });
    });
  }, [focusSignal]);
  // The editor's mount: the editor owns the DOM from here; the flat model
  // stays in sync through the update listener (document → string) and the
  // loaders below (string → document).
  useEffect(() => {
    const rootElement = editorRootRef.current;
    if (rootElement === null) {
      return;
    }
    const editor = lexicalEditorRef.current ?? (lexicalEditorRef.current = createComposerEditor(
      (error) => {
        log.error("composer", "lexical editor error: " + error.message);
      },
      (files) => {
        if (attachEnabledRef.current) {
          onPaste(files);
        }
      },
    ));
    editor.setRootElement(rootElement);
    const unregisterHistory = registerHistory(editor, createEmptyHistoryState(), 1000);
    const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const serialized = serializeComposerRoot();
        const caret = $caretModelOffsets();
        setText((current) => (current === serialized ? current : serialized));
        if (caret !== null) {
          mentionUpdateRef.current?.(serialized, caret.end);
        }
      });
    });
    const registerHotkey = <Payload,>(command: LexicalCommand<Payload>, listener: (event: Payload) => boolean): (() => void) => editor.registerCommand(command, listener, COMMAND_PRIORITY_CRITICAL);
    const unregisterEnter = registerHotkey(KEY_ENTER_COMMAND, (event) => {
      event?.preventDefault();
      enterHandlerRef.current(event);
      return true;
    });
    const unregisterEscape = registerHotkey(KEY_ESCAPE_COMMAND, () => escapeHandlerRef.current());
    const unregisterArrowDown = registerHotkey(KEY_ARROW_DOWN_COMMAND, () => mentionNavigationRef.current("ArrowDown"));
    const unregisterArrowUp = registerHotkey(KEY_ARROW_UP_COMMAND, () => mentionNavigationRef.current("ArrowUp"));
    const unregisterTab = registerHotkey(KEY_TAB_COMMAND, () => mentionNavigationRef.current("Tab"));
    // The initial load: the model text as of this mount, caret at the end.
    const end = textRef.current.length;
    loadComposerText(editor, textRef.current, { start: end, end });
    editor.focus();
    return () => {
      unregisterTab();
      unregisterArrowUp();
      unregisterArrowDown();
      unregisterEscape();
      unregisterEnter();
      unregisterUpdate();
      unregisterHistory();
      editor.setRootElement(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- a one-time mount: the editor element exists for the component's lifetime
  const users = useStore(session.rosterStore, (state) => state.users);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const ctrlEnterSends = useStore(settingsStore, (settings) => settings.ctrlEnterSends);
  const emojiState = useStore(session.emojiStore, (state) => state);
  const stickerState = useStore(session.stickerStore, (state) => state);
  // The picker's tab is the LAST-USED one, persisted through restarts (the Discord
  // picker model, user decision 2026-09-30): switching a tab writes through quietly,
  // opening the picker lands on what was used last. A remembered Stickers tab with
  // no sticker catalog (unsupported server) falls back to Emoji.
  const storedPickerTab = useStore(settingsStore, (settings) => settings.pickerLastTab);
  const pickerTab = storedPickerTab === "stickers" && stickerState.supported ? "stickers" : "emoji";
  const selectPickerTab = (tab: "emoji" | "stickers"): void => {
    settingsStore.apply({ pickerLastTab: tab }); // the persistedGain category — instant, not staged
  };
  const recentExpressions = useStore(settingsStore, (settings) => settings.recentExpressions);
  const emojiMatches = useMemo(() => filterEmojis(emojiState.emojis, pickerQuery), [emojiState.emojis, pickerQuery]);
  const builtInMatches = useMemo(
    () => filterBuiltInReactions(REACTION_CATALOG, pickerQuery),
    [pickerQuery],
  );
  const recentEntries = useMemo(
    () => resolveRecentExpressionEntries(recentExpressions, emojiState.byName, pickerQuery),
    [emojiState, recentExpressions, pickerQuery],
  );
  const stickerPackMatches = useMemo(
    () => filterStickerPacks(stickerState.packs, pickerQuery),
    [stickerState.packs, pickerQuery],
  );

  // oak's MentionSuggester order: @everyone/@here first, then MENTIONABLE roles,
  // then users — one flat list the keyboard walks (live report: roles and the
  // broad pings were missing from the popup entirely). Users walk by NICKNAME
  // (the one addressable name — the login never matches), and the trigger token
  // class is Unicode to match the nickname grammar (Cyrillic included).
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) {
      return [];
    }
    const prefix = mentionQuery.token.slice(1).toLowerCase(); // after the @
    const matches = (label: string): boolean => label.toLowerCase().startsWith(prefix);
    const candidates: { key: string; insert: string; label: string; kind: "broad" | "role" | "user"; userId?: number }[] = [];
    for (const broad of ["everyone", "here"]) {
      if (matches(broad)) {
        candidates.push({ key: `broad:${broad}`, insert: broad, label: `@${broad}`, kind: "broad" });
      }
    }
    for (const role of roles) {
      if (role.kind === "CUSTOM" && role.mentionable && matches(role.name)) {
        candidates.push({ key: `role:${role.id}`, insert: role.name, label: `@${role.name}`, kind: "role" });
      }
    }
    for (const user of users) {
      const shownName = user.displayName ?? user.username;
      if (user.username !== ownUsername && matches(shownName)) {
        candidates.push({ key: `user:${user.id}`, insert: shownName, label: shownName, kind: "user", userId: user.id });
      }
    }
    return candidates.slice(0, 10);
  }, [mentionQuery, roles, users, ownUsername]);

  // Track the @token ending at the caret — the popup's query (Unicode token class).
  const updateMentionQuery = (value: string, caret: number): void => {
    const beforeCaret = value.slice(0, caret);
    const tokenMatch = beforeCaret.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
    setMentionQuery(tokenMatch !== null ? { token: tokenMatch[0].trimStart(), caret } : null);
    setMentionIndex(0);
  };

  const applyMention = (insert: string): void => {
    if (mentionQuery === null) {
      return;
    }
    const start = mentionQuery.caret - mentionQuery.token.length;
    // A MOUSE click on a suggestion row moves the focus out of the field —
    // applyEditorRange refocuses and re-places the caret after "@name ".
    applyEditorRange(`${text.slice(0, start)}@${insert} ${text.slice(mentionQuery.caret)}`, start + insert.length + 2, start + insert.length + 2);
  };

  /** Inserts an arbitrary string at the caret (through the model). The
   *  picker STAYS open — Discord's behavior — until Escape or an
   *  outside click closes it. */
  const insertAtCaret = (insert: string): void => {
    const caret = modelSelection();
    applyEditorRange(
      `${text.slice(0, caret.start)}${insert}${text.slice(caret.end)}`,
      caret.start + insert.length,
      caret.start + insert.length,
    );
  };

  /** Inserts ":name:" — and records the use into the shared Latest MRU. */
  const applyEmoji = (name: string): void => {
    insertAtCaret(`:${name}:`);
    recordRecentExpression(`:${name}:`);
  };

  /** A built-in unicode emoji inserts its GLYPH — it has no catalog row and no
   *  ":name:" token (the reaction picker's Built-in section mirrored here, so a
   *  text message can carry exactly what a reaction can, user request 2026-09-30). */
  const applyBuiltInEmoji = (entry: BuiltInReaction): void => {
    insertAtCaret(entry.glyph);
    recordRecentExpression(entry.slug);
  };

  const closePicker = (): void => {
    setPickerOpen(false);
    setPickerQuery("");
  };

  // The BUTTON rides as the popup's anchor: its own press does not count as
  // "outside", so the onClick toggle closes the picker instead of racing the
  // outside-dismiss into a reopen (live report).
  useOutsideDismiss(pickerRef, () => {
    if (pickerOpen) {
      closePicker();
    }
  }, pickerButtonRef);

  /** The stickers tab's click-to-send: fires the sticker message immediately,
   *  closing the picker only on SUCCESS (the failed-send discipline: surfaces
   *  that hold state survive a retry). Shares the composer's `busy` with submit —
   *  an Enter-send and a sticker click can never interleave. */
  const sendSticker = async (sticker: Sticker): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSendSticker(sticker);
      closePicker();
    } catch (stickerError) {
      setError(stickerError instanceof Error ? stickerError.message : String(stickerError));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const content = text.trim();
    if ((!content && !allowEmptySend) || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSend(content);
      // The model empties through the editor primitive, so the WYSIWYG DOM
      // rebuilds too (a bare setText would leave the sent text on screen).
      applyEditorRange("", 0, 0);
      // A sent message closes the picker (user request) — but a FAILED send
      // keeps it: the draft survives, so does the picker.
      closePicker();
    } catch (submitError) {
      // Keep the text — a failed send must never eat the draft.
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  // The EDITOR context menu (user request 2026-10-27): Electron renders no
  // native one inside a textarea, so right-click offers the standard editing
  // verbs through the app's own ContextMenu. Clipboard state is probed
  // asynchronously the moment the menu opens (Paste flips on when the
  // clipboard holds text); the selection verbs read the field synchronously.
  // Spell check (2026-11-03) rides the same menu: main forwards the platform's
  // misspelling data (webContents context-menu params — the only source of
  // dictionary suggestions) a tick AFTER this handler opens the menu; the push
  // is matched against the word under the caret and dropped when it disagrees
  // (a stale push from an earlier click would otherwise graft suggestions onto
  // the wrong menu).
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    hasText: boolean;
    canPaste: boolean;
    /** The word under the caret at open time — the spelling block's anchor. */
    spellWord: string | null;
    /** True once the embedded checker confirmed the word is misspelled —
     *  gates the submenu row (a correct word gets no spelling entry). */
    spellMisspelled: boolean;
    /** The checker's suggestions for the word (may be empty — the submenu then
     *  still offers Add to dictionary). */
    spellSuggestions: string[];
  } | null>(null);

  // The Settings → General toggle gates the spelling row TOO (live smoke
  // 2026-11-03: with checking off the underlines were gone but the row with
  // suggestions stayed — the checker answers regardless of its consumers).
  const spellCheckEnabled = useStore(settingsStore, (settings) => settings.spellCheckEnabled);

  useEffect(() => {
    const spellBridge = window.spaceSpell;
    if (!spellBridge) {
      return; // tests / a preload without the bridge — no suggestions, menu intact
    }
    spellBridge.onContextMenu((event) => {
      setEditorMenu((current) =>
        current === null || current.spellWord !== event.misspelledWord || event.suggestions.length === 0
          ? current // no menu open, another word, or platform-empty suggestions (Windows) — drop it
          : { ...current, spellMisspelled: true, spellSuggestions: event.suggestions }); // richer platform list wins
    });
  }, []);

  /** Applies a text change to the MODEL: state set, a stale @-query dropped,
   *  the document reloaded with the caret where the edit put it. */
  const applyEditorRange = (nextText: string, caretStart: number, caretEnd: number): void => {
    setText(nextText);
    setMentionQuery(null);
    const editor = lexicalEditorRef.current;
    if (editor !== null && editor.getRootElement() !== null) {
      loadComposerText(editor, nextText, { start: caretStart, end: caretEnd });
      editor.focus();
    }
  };

  const applyEditorText = (nextText: string, caret: number): void => {
    applyEditorRange(nextText, caret, caret);
  };

  /** The live caret/selection as MODEL offsets (the editor's selection lives
   *  in the editor state, so it survives a blurred element). */
  const modelSelection = (): { start: number; end: number } => {
    const editor = lexicalEditorRef.current;
    if (editor !== null && editor.getRootElement() !== null) {
      return editor.getEditorState().read($caretModelOffsets) ?? { start: text.length, end: text.length };
    }
    return { start: text.length, end: text.length };
  };

  /** A formatting action — the ONE path for both the hotkeys (Ctrl+B/I/U,
   *  Ctrl+Shift+X) and the context menu's Formatting block. The LIVE
   *  selection rides Lexical's FORMAT_TEXT_COMMAND: a selection toggles the
   *  format over exactly the SEEN characters (a word inside a strike run
   *  unwraps honestly — the old model-wrap could only unwrap a WHOLE pair and
   *  produced `~~one two ~~three~~~~` junk when the range sat inside an
   *  existing pair), an EMPTY caret toggles the FLOWING format (the
   *  selection's format keeps applying to everything typed next — Discord's
   *  typing toggle). The selection lives in the EDITOR STATE, so it survives
   *  the menu click's blur (the copy/cut discipline). The model wrap stays as
   *  the fallback when the editor is not attached. */
  const toggleWrapSelection = (marker: string): void => {
    const editor = lexicalEditorRef.current;
    if (editor !== null && editor.getRootElement() !== null && applyLiveFormatCommand(editor, marker)) {
      return;
    }
    const range = modelSelection();
    const result = wrapSelectionInMarker(text, range.start, range.end, marker);
    applyEditorRange(result.next, result.nextStart, result.nextEnd);
  };

  const runEditorVerb = (verb: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll"): void => {
    // Lexical machinery: undo/redo through the registered history, selectAll
    // over the document paragraph, paste through the plain inserter; the
    // clipboard verbs speak the MODEL — the editor state holds the selection
    // even after a menu click blurred the element.
    const editor = lexicalEditorRef.current;
    if (editor === null || editor.getRootElement() === null) {
      return;
    }
    editor.focus();
    if (verb === "undo" || verb === "redo") {
      editor.dispatchCommand(verb === "undo" ? UNDO_COMMAND : REDO_COMMAND);
      return;
    }
    if (verb === "selectAll") {
      editor.update(() => {
        const first = $getRoot().getFirstChild();
        if ($isParagraphNode(first)) {
          first.select();
        }
      }, { discrete: true });
      return;
    }
    if (verb === "paste") {
      void navigator.clipboard.readText().then((inserted) => {
        if (inserted.length > 0) {
          insertPlainText(editor, inserted);
        }
      }).catch(() => undefined);
      return;
    }
    const { start, end } = modelSelection();
    const selected = text.slice(start, end);
    if (verb === "copy") {
      void navigator.clipboard.writeText(selected).catch(() => undefined);
      return;
    }
    if (verb === "cut" || verb === "delete") {
      if (verb === "cut") {
        void navigator.clipboard.writeText(selected).catch(() => undefined);
      }
      applyEditorText(`${text.slice(0, start)}${text.slice(end)}`, start);
      return;
    }
  };

  /** Applies a picked dictionary suggestion: the replacement happens LOCALLY
   *  (a model edit — synchronous, no IPC for the text itself); the caret has
   *  not moved since the menu opened (a menu click does not touch the editor),
   *  but a mismatching word aborts rather than replacing the wrong thing. */
  const applySpellSuggestion = (word: string, suggestion: string): void => {
    const caret = modelSelection().start;
    const range = wordRangeAt(text, caret);
    if (range === null || text.slice(range.start, range.end) !== word) {
      return;
    }
    applyEditorText(
      text.slice(0, range.start) + suggestion + text.slice(range.end),
      range.start + suggestion.length,
    );
  };

  /** Add to dictionary: the session-level add (instant underline removal for
   *  this run) plus the persisted list — Chromium's custom dictionary does not
   *  survive restarts, so the words live in ClientSettings and main re-seeds
   *  them at every boot. */
  const addSpellWord = (word: string): void => {
    void window.spaceSpell?.addWord(word);
    settingsStore.apply({
      spellCheckWords: withAddedSpellWord(settingsStore.getSnapshot().spellCheckWords, word),
    });
  };

  /** A newline at the caret — Shift/Ctrl+Enter. */
  const insertNewline = (): void => {
    const editor = lexicalEditorRef.current;
    if (editor === null || editor.getRootElement() === null) {
      return;
    }
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertLineBreak();
      }
    }, { discrete: true });
  };

  /** Enter semantics are SETTINGS-OWNED (M7): default Enter sends and
   *  Ctrl/Shift+Enter newline; with ctrlEnterSends the roles swap (Shift
   *  stays a newline in both configurations). Driven by the Enter command. */
  const runEnterSemantics = (ctrlKey: boolean, shiftKey: boolean, altKey: boolean): void => {
    const plainEnter = !ctrlKey && !shiftKey && !altKey;
    const ctrlEnter = ctrlKey && !shiftKey && !altKey;
    const shiftEnter = shiftKey && !altKey;
    const sendOnThisEnter = ctrlEnterSends ? ctrlEnter : plainEnter;
    const newlineOnThisEnter = ctrlEnterSends ? plainEnter || shiftEnter : ctrlEnter || shiftEnter;
    if (sendOnThisEnter) {
      void submit();
    } else if (newlineOnThisEnter) {
      insertNewline();
    }
  };

  // The WYSIWYG key handlers' FRESH closures (see the refs above): the Lexical
  // commands are registered once per mount, the refs re-bind every render —
  // the editor's whole keyboard contract is answered inside Lexical because
  // it sees keydown first.
  useEffect(() => {
    mentionUpdateRef.current = (value, caret) => updateMentionQuery(value, caret);
    enterHandlerRef.current = (event) => {
      if (mentionQuery !== null && mentionCandidates.length > 0) {
        applyMention(mentionCandidates[mentionIndex]!.insert);
        return;
      }
      runEnterSemantics(event?.ctrlKey ?? false, event?.shiftKey ?? false, event?.altKey ?? false);
    };
    mentionNavigationRef.current = (key) => {
      if (mentionQuery === null || mentionCandidates.length === 0) {
        return false;
      }
      if (key === "ArrowDown") {
        setMentionIndex((index) => (index + 1) % mentionCandidates.length);
        return true;
      }
      if (key === "ArrowUp") {
        setMentionIndex((index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length);
        return true;
      }
      applyMention(mentionCandidates[mentionIndex]!.insert); // Enter / Tab
      return true;
    };
    escapeHandlerRef.current = () => {
      if (onCancelReply !== null) {
        onCancelReply();
        return true;
      }
      if (mentionQuery !== null) {
        setMentionQuery(null);
        return true;
      }
      return false;
    };
  });

  /** The editor's context menu (Electron shows no native menu in a
   *  contentEditable — our own verb set). */
  const onComposerContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    const selection = modelSelection();
    // A right click moves the caret onto the clicked word, so the model caret
    // already names it (a live SELECTION is not moved — its first word then).
    const caretWordRange = wordRangeAt(text, selection.start);
    const caretWord = caretWordRange !== null ? text.slice(caretWordRange.start, caretWordRange.end) : null;
    setEditorMenu({
      x: event.clientX,
      y: event.clientY,
      hasSelection: selection.end > selection.start,
      hasText: text.length > 0,
      canPaste: false,
      spellWord: caretWord,
      spellMisspelled: false,
      spellSuggestions: [],
    });
    // Spell-check menu data comes from the EMBEDDED dictionaries (the
    // platform's context-menu params stay empty on Windows —
    // electron/electron#38876): ask about the word under the caret the moment
    // the menu opens; the answer patches the menu in. Skipped while off.
    if (caretWord !== null && spellCheckEnabled) {
      void window.spaceSpell?.menuData(caretWord)
        .then((data) => setEditorMenu((current) =>
          current === null || current.spellWord !== caretWord
            ? current // the menu closed or moved on — drop the answer
            : {
              ...current,
              spellMisspelled: data.misspelled,
              spellSuggestions: data.misspelled ? data.suggestions : [],
            }))
        .catch(() => undefined);
    }
    // Async clipboard probe: Paste enables itself when text is there.
    void navigator.clipboard.readText()
      .then((probe) => setEditorMenu((current) =>
        current === null ? current : { ...current, canPaste: probe.length > 0 }))
      .catch(() => setEditorMenu((current) =>
        current === null ? current : { ...current, canPaste: true }));
  };

  /** The editor's keydown — ONLY Ctrl+Shift+X (strike; plain Ctrl+X stays
   *  Cut). Everything else with a keyboard contract is answered elsewhere:
   *  Enter semantics, the @-popup navigation and Escape by the REGISTERED
   *  Lexical commands (they see keydown before React's delegated handler),
   *  and Ctrl+B/I/U BY RICH-TEXT ITSELF — the plugin intercepts those and
   *  dispatches FORMAT_TEXT_COMMAND, which OUR critical-priority handler
   *  answers with the toggle semantics. Dispatching our own command from
   *  here too would toggle TWICE and cancel out (the probe-caused smoke
   *  bug: bold "worked once" and strike markers leaked as plain text).
   *  Matched by event.code so the RUSSIAN layout keeps working (Ctrl+Ч =
   *  physical X). */
  const onComposerKeyDown = (event: React.KeyboardEvent): void => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyX") {
      event.preventDefault();
      toggleWrapSelection("~~");
    }
  };

  return (
    <div className="composer">
      {mentionQuery !== null && mentionCandidates.length > 0 ? (
        <div className="mention-popup">
          {mentionCandidates.map((candidate, index) => (
            <div
              key={candidate.key}
              className={"mention-row" + (index === mentionIndex ? " chosen" : "")}
              onClick={() => applyMention(candidate.insert)}
            >
              {candidate.kind === "user" ? (
                <Avatar session={session} username={candidate.insert} size={20} />
              ) : (
                <span className="icon mdi-account-multiple mention-row-glyph" />
              )}
              <span>{candidate.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {/* The unified expression picker (the Discord model, user decision 2026-09-30):
          ONE smile button, ONE popup with Emoji | Stickers tabs on top and a shared
          search. The Emoji tab ALWAYS exists — its Built-in section is pure
          client-side — while Stickers needs the server catalog. The tab is the
          last-used one, persisted through restarts. The two tabs keep their click
          asymmetry: an emoji INSERTS at the caret (popup stays), a sticker SENDS
          immediately (popup closes, text draft untouched). The Latest row on top is
          the shared MRU of used expressions (both pickers feed it). */}
      {pickerOpen ? (
        <div ref={pickerRef} className="composer-picker">
          <div className="picker-tabs">
            <button
              className={"picker-tab" + (pickerTab === "emoji" ? " active" : "")}
              onClick={() => selectPickerTab("emoji")}
            >{t("picker.tabEmoji")}</button>
            {stickerState.supported ? (
              <button
                className={"picker-tab" + (pickerTab === "stickers" ? " active" : "")}
                onClick={() => selectPickerTab("stickers")}
              >{t("picker.tabStickers")}</button>
            ) : null}
          </div>
          <input
            className="picker-search"
            type="text"
            placeholder={pickerTab === "emoji" ? t("picker.searchEmojis") : t("picker.searchStickers")}
            value={pickerQuery}
            onChange={(event) => setPickerQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation(); // the textarea's own Escape handlers stay quiet
                closePicker();
              }
            }}
          />
          <div className="picker-body">
            {pickerTab === "emoji" ? (
              recentEntries.length === 0 && builtInMatches.length === 0 && emojiMatches.length === 0 ? (
                <div className="picker-empty">{t("picker.nothingMatches")}</div>
              ) : (
                <>
                  {recentEntries.length > 0 ? (
                    <div className="picker-section">
                      <div className="picker-section-title">{t("picker.latest")}</div>
                      <div className="expression-tile-grid">
                        {recentEntries.map((entry) => (
                          <RecentExpressionTile
                            key={entry.slug}
                            session={session}
                            entry={entry}
                            onPick={() => (entry.emoji !== null
                              ? applyEmoji(entry.emoji.name)
                              : applyBuiltInEmoji({ slug: entry.slug, glyph: entry.glyph ?? entry.slug }))}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {builtInMatches.length > 0 ? (
                    <div className="picker-section">
                      <div className="picker-section-title">{t("picker.builtIn")}</div>
                      <div className="expression-tile-grid">
                        {builtInMatches.map((entry) => (
                          <BuiltInEmojiTile key={entry.slug} entry={entry} onPick={() => applyBuiltInEmoji(entry)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {emojiMatches.length > 0 ? (
                    <div className="picker-section">
                      <div className="picker-section-title">{t("picker.custom")}</div>
                      <div className="emoji-tile-grid">
                        {emojiMatches.map((emoji) => (
                          <EmojiTile key={emoji.id} session={session} emoji={emoji} onPick={() => applyEmoji(emoji.name)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )
            ) : (
              stickerPackMatches.length === 0 ? (
                <div className="picker-empty">
                  {stickerState.packs.length === 0 ? t("picker.noStickersYet") : t("picker.nothingMatches")}
                </div>
              ) : (
                stickerPackMatches.map((pack) => (
                  <div key={pack.id} className="sticker-pack-section">
                    <div className="sticker-pack-title">
                      {pack.name}
                      <span className="sticker-pack-count">{pack.stickers.length}</span>
                    </div>
                    <div className="sticker-tile-grid">
                      {pack.stickers.map((sticker) => (
                        <StickerTile
                          key={sticker.id}
                          session={session}
                          sticker={sticker}
                          disabled={busy}
                          onPick={() => void sendSticker(sticker)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )
            )}
          </div>
        </div>
      ) : null}
      <div className="composer-card">
        {/* oak's applyComposerGating: without ATTACH_FILES the paperclip HIDES
            (never disables); the composer itself stays. Glyph = Icons.attach(). */}
        {attachEnabled ? (
          <button
            className="composer-attach"
            title={t("chat.attachFiles")}
            onClick={() => fileInputRef.current?.click()}
          ><span className="icon mdi-paperclip" /></button>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            onPaste([...event.target.files ?? []]);
            event.target.value = ""; // allow picking the same file twice
          }}
        />
        {/* The composer's editor (Lexical): React renders no children into it —
           the editor attaches itself to the element in the mount effect and
           owns the DOM, the caret and the typing from there; the document
           serializes into the flat marker model on every update. Markers are
           hidden (the text shows as it will render in chat); ":name:" tokens
           stay literal text here. */}
        <div
          ref={editorRootRef}
          className={"composer-editor-formatted" + (text.trim().length === 0 ? " is-empty" : "")}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          spellCheck={true}
          data-placeholder={fittedPlaceholder}
          onContextMenu={onComposerContextMenu}
          onKeyDown={onComposerKeyDown}
        />
        {/* The single smile button at the card's RIGHT edge opens the unified
            expression picker. ALWAYS visible (user request 2026-09-30): the Emoji
            tab's Built-in glyphs are pure client-side — a text message can carry
            exactly what a reaction can, no server catalog needed. Not
            ATTACH_FILES-gated: picker access needs no permission. */}
        <button
          ref={pickerButtonRef}
          className="composer-attach"
          title={pickerTab === "emoji" ? "Emoji & stickers" : "Stickers & emoji"}
          onClick={() => {
            setPickerOpen((open) => !open);
            setPickerQuery("");
            setMentionQuery(null); // the picker and the @-popup are mutually exclusive
          }}
        ><span className="icon mdi-emoticon" /></button>
      </div>
      {/* No hint line under the card (oak has none) — the composer's bottom
          inset matches the left overlay card's, so the two read as a pair.
          The error line only exists while a send actually failed. */}
      {error !== null ? <div className="composer-error">{error}</div> : null}
      {editorMenu !== null ? (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          items={[
            { label: t("chat.undo"), action: () => runEditorVerb("undo") },
            { label: t("chat.redo"), action: () => runEditorVerb("redo") },
            { separator: true },
            { label: t("chat.cut"), disabled: !editorMenu.hasSelection, action: () => runEditorVerb("cut") },
            { label: t("chat.copy"), disabled: !editorMenu.hasSelection, action: () => runEditorVerb("copy") },
            { label: t("chat.paste"), disabled: !editorMenu.canPaste, action: () => runEditorVerb("paste") },
            { label: t("common.delete"), disabled: !editorMenu.hasSelection, action: () => runEditorVerb("delete") },
            { separator: true },
            { label: t("chat.selectAll"), disabled: !editorMenu.hasText, action: () => runEditorVerb("selectAll") },
            // The formatting row (user request 2026-11-03, right above the
            // spelling row): the same Telegram shape — "Formatting ›" opening
            // the six marker actions to the right. Needs a SELECTION (each
            // action wraps/unwraps what is selected); the items work on the
            // range CAPTURED AT OPEN — a menu click blur-blanks the live one —
            // and edit the model directly.
            ...(editorMenu.hasSelection ? [{
              label: t("chat.formattingSubmenu"),
              action: () => undefined,
              children: [
                { label: t("chat.formatBold"), action: () => toggleWrapSelection("**") },
                { label: t("chat.formatItalic"), action: () => toggleWrapSelection("*") },
                { label: t("chat.formatUnderline"), action: () => toggleWrapSelection("__") },
                { label: t("chat.formatStrike"), action: () => toggleWrapSelection("~~") },
                { label: t("chat.formatSpoiler"), action: () => toggleWrapSelection("||") },
                { label: t("chat.formatCode"), action: () => toggleWrapSelection("`") },
              ],
            }] : []),
            // Spell-check row at the BOTTOM (user request 2026-11-03 — the
            // Telegram shape): one "Spelling ›" entry opening the suggestions +
            // Add-to-dictionary in a submenu to the right; shown only for a
            // confirmed misspelling.
            ...(spellCheckEnabled && editorMenu.spellMisspelled && editorMenu.spellWord !== null ? [{
              label: t("chat.spellingSubmenu"),
              action: () => undefined,
              children: [
                ...editorMenu.spellSuggestions.slice(0, 5).map((suggestion) => ({
                  label: suggestion,
                  action: () => applySpellSuggestion(editorMenu.spellWord!, suggestion),
                })),
                { separator: true } as const,
                { label: t("chat.addSpellWord", { word: editorMenu.spellWord }), action: () => addSpellWord(editorMenu.spellWord!) },
              ],
            }] : []),
          ]}
          onClose={() => setEditorMenu(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forward dialog (same-instance full; cross-instance text-only, attachments → M3)
// ---------------------------------------------------------------------------

function ForwardDialog({ session, source, sourceChannel, onClose }: {
  session: ConnectionSession;
  source: readonly Message[];
  sourceChannel: Channel;
  onClose(): void;
}): React.JSX.Element {
  const t = useT();
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const ownChannels = useStore(session.channelStore, (channels) => channels);
  const [targetRecordId, setTargetRecordId] = useState(session.recordId);
  const [foreignChannels, setForeignChannels] = useState<readonly Channel[] | null>(null);
  const [targetChannelId, setTargetChannelId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crossInstance = targetRecordId !== session.recordId;
  const hasAttachments = source.some((message) => message.attachments.length > 0);

  // Another server's channel list arrives through a throwaway client for its record.
  useEffect(() => {
    if (!crossInstance) {
      setForeignChannels(null);
      setTargetChannelId(null);
      return;
    }
    let cancelled = false;
    const record = connectionDirectory.get(targetRecordId);
    if (!record) {
      return;
    }
    const client = new RestClient({
      baseUrl: record.hostUrl,
      tokenStorage: new RecordTokenStorage(connectionDirectory, targetRecordId),
    });
    void client.getChannels()
      .then((channels) => {
        if (!cancelled) {
          setForeignChannels(channels.filter((entry) => entry.type === "TEXT"));
        }
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setForeignChannels([]);
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [targetRecordId, crossInstance]);

  const targetChannels = crossInstance ? foreignChannels : ownChannels.filter((entry) => entry.type === "TEXT");
  const originServer = connectionDirectory.get(session.recordId)?.cachedServerName ?? session.hostUrl();

  const submit = async (): Promise<void> => {
    if (targetChannelId === null || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!crossInstance) {
        for (const message of source) {
          await session.forwardMessage(targetChannelId, message.id, comment.length > 0 ? comment : null);
        }
      } else {
        for (const message of source) {
          // Cross-instance attachments are re-uploaded: mint a slot on the TARGET
          // instance, pull the bytes from the source's (possibly re-minted) link.
          // The re-uploaded bytes are identical — the source's measured intrinsic
          // dimensions and byte size stay valid and ride along.
          const targetAttachments: { key: string; fileName: string; width: number | null; height: number | null; sizeBytes: number | null }[] = [];
          for (const attachment of message.attachments) {
            if (attachment.key === null) {
              continue;
            }
            const fresh = await session.rest.freshAttachmentLink(attachment.key);
            if (fresh === null) {
              continue; // the object died — forward without it rather than fail
            }
            const bytes = new Uint8Array(await session.rest.downloadBytes(fresh));
            const targetSlot = await forwardRequestUpload(targetRecordId, attachment.fileName);
            await forwardUploadBytes(targetRecordId, targetSlot.uploadUrl, bytes);
            targetAttachments.push({
              key: targetSlot.key,
              fileName: attachment.fileName,
              width: attachment.width ?? null,
              height: attachment.height ?? null,
              sizeBytes: bytes.byteLength,
            });
          }
          // A sticker-only message would otherwise 400 ("forward must have content
          // or an attachment") — the target server cannot serve the origin's sticker
          // keys, so the sticker rides over as a regular image attachment (the same
          // re-upload machinery). The copy keeps rendering as a picture there.
          if (message.sticker !== null
              && targetAttachments.length === 0
              && (message.content ?? "").trim().length === 0) {
            const freshStickerLink = await session.rest.freshAttachmentLink(message.sticker.key);
            if (freshStickerLink !== null) {
              const stickerBytes = new Uint8Array(await session.rest.downloadBytes(freshStickerLink));
              const stickerFileName = stickerForwardFileName(message.sticker);
              const stickerSlot = await forwardRequestUpload(targetRecordId, stickerFileName);
              await forwardUploadBytes(targetRecordId, stickerSlot.uploadUrl, stickerBytes);
              targetAttachments.push({
                key: stickerSlot.key,
                fileName: stickerFileName,
                width: null,
                height: null,
                sizeBytes: stickerBytes.byteLength,
              });
            }
          }
          await forwardCrossInstance(targetRecordId, targetChannelId, {
            content: (message.content?.length ?? 0) > 0 ? message.content : comment,
            attachments: targetAttachments.length > 0 ? targetAttachments : null,
            originServer,
            originChannel: sourceChannel.name,
            originAuthorId: message.authorId,
            // The snapshot carries the NICKNAME (the login never crosses the wire).
            originAuthorName: displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
            originCreatedAt: message.createdAt,
            originReply: message.reply,
          });
        }
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={source.length === 1
      ? t("chat.forwardOneTitle")
      : t("chat.forwardManyTitle", { count: source.length })} onClose={onClose}>
      <div className="forward-picker">
        <div className="forward-column">
          <div className="forward-column-title">{t("common.server")}</div>
          {records.map((record) => (
            <div key={record.id}
              className={"forward-row" + (record.id === targetRecordId ? " chosen" : "")}
              onClick={() => setTargetRecordId(record.id)}>
              <span className="forward-badge">{(record.cachedServerName ?? record.hostUrl).charAt(0).toUpperCase()}</span>
              <span className="forward-row-name">{record.cachedServerName ?? record.hostUrl}</span>
            </div>
          ))}
        </div>
        <div className="forward-column">
          <div className="forward-column-title">{t("sidebar.channelsTitle")}</div>
          {targetChannels === null ? <div className="forward-note">{t("chat.loadingChannels")}</div> : null}
          {targetChannels?.length === 0 ? <div className="forward-note">{t("chat.noTextChannels")}</div> : null}
          {targetChannels?.map((entry) => (
            <div key={entry.id}
              className={"forward-row" + (entry.id === targetChannelId ? " chosen" : "")}
              onClick={() => setTargetChannelId(entry.id)}>
              # {entry.name}
            </div>
          ))}
        </div>
      </div>
      <input type="text" value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t("chat.commentOptional")} />
      {crossInstance && hasAttachments ? (
        <div className="modal-note">{t("chat.forwardReuploadNote")}</div>
      ) : null}
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary" disabled={busy || targetChannelId === null} onClick={() => void submit()}>{t("chat.forwardVerb")}</button>
      </div>
    </Modal>
  );
}
