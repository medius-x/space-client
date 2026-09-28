import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { ackActiveChannel, appStore, forwardCrossInstance, forwardRequestUpload, forwardUploadBytes } from "../runtime";
import { closeDiscussionForEveryone, closeDiscussionView, openDiscussion, openDraftDiscussion } from "../runtime";
import { connectionDirectory, settingsStore } from "../runtime";
import { RecordTokenStorage } from "../../domain/session/connection-record";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { HISTORY_PAGE, NEWER_PAGE } from "../../domain/session/connection-session";
import { RestClient } from "../../core/rest";
import { log } from "../../logging";
import { computeGroupStarts, continuesGroup, formatHeaderStamp, formatTimeOfDay, toEpochMs, type GroupableMessage } from "../../domain/logic/message-grouping";
import { firstHttpUrl, segmentMessageContent } from "../../domain/logic/mention-segmenter";
import {
  filterEmojis,
  isEmojiOnlyMessage,
  jumboEmojiEstimateExtra,
  JUMBO_EMOJI_DEFAULT_PX,
} from "../../domain/logic/emoji-picker";
import { displayNameOf } from "../../domain/logic/display-name";
import { tileReplyLabel } from "../../domain/logic/discussions-view";
import { linkPreviewFor, type LinkPreview } from "../link-preview";
import { notifications } from "../notifications";
import { dmDisplayName } from "../../domain/logic/dm-display";
import { memberNameColor } from "../../domain/logic/roster-grouping";
import { paletteColor } from "../../domain/logic/user-palette";
import type { Channel, ChannelMyPermissions, CustomEmoji, Discussion, DmChannel, ForwardInfo, Message, ReplyInfo } from "../../types";
import { REACTION_CATALOG, REACTION_GLYPH_BY_SLUG } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { AttachmentView } from "./AttachmentView";
import { isAudioFile, isImageFile, isVideoFile, reservedVideoThumbBox, singleTileBox } from "../../domain/logic/attachment-layout";
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
const QUOTE_DEPTH_MAX = 5;

/**
 * Content-aware height estimate — the flatter the estimate, the more totalHeight
 * "breathes" when measurement replaces it, and a breathing scrollHeight makes the
 * scrollbar thumb drift off the cursor mid-drag (the mapping denominator moves).
 * CONTINUATION rows of a group are estimated with a smaller base (~22px reality)
 * than head rows — inside big single-author groups the old flat 30px base doubled
 * the estimate→measure delta on every row and the extent never stopped moving
 * (live report). Grouping knowledge arrives via MessageList's startById map.
 */
function estimateRowHeight(message: Message, startsGroup: boolean, hasDiscussionTile = false, jumboEmojiPx = JUMBO_EMOJI_DEFAULT_PX): number {
  const CHARS_PER_LINE = 72;
  const lines = message.content === null ? 0 : Math.max(1, Math.ceil(message.content.length / CHARS_PER_LINE));
  let height = (startsGroup ? 30 : 24) + lines * 21;
  // A potentially-jumbo row (emoji-only content) grows with the reader's size
  // setting — prepaid here so measurement does not shift rows below it.
  height += jumboEmojiEstimateExtra(message.content, jumboEmojiPx);
  if (message.reply !== null) {
    height += 34;
  }
  if (message.forward !== null) {
    height += 30;
  }
  if (message.reactions.length > 0) {
    height += 26;
  }
  if (hasDiscussionTile) {
    height += 24;
  }
  // Media-aware attachment estimate (live report: a flat +22 made every
  // picture/video row JUMP on measure — the real mosaic is 200-500px, and the
  // estimate→fact delta shifted everything below it). Rough by design — but the
  // 2026-09-25 exact-reservation round upgrades it: the wire now carries the
  // media's intrinsic dimensions (and legacy rows learn them after one decode),
  // so single images and video thumbs estimate by their real aspect instead of
  // a flat magnitude. Multi-image mosaics stay count-based (square crops).
  let attachmentEstimate = 0;
  let imageTiles = 0;
  let singleImage: { width: number; height: number } | null = null;
  for (const attachment of message.attachments) {
    const known = attachment.width !== null && attachment.height !== null
      ? { width: attachment.width, height: attachment.height }
      : learnedDims(attachment.key);
    if (isImageFile(attachment.fileName)) {
      imageTiles += 1;
      if (singleImage === null) {
        singleImage = known;
      }
    } else if (isVideoFile(attachment.fileName)) {
      attachmentEstimate += known !== null
        ? reservedVideoThumbBox(known.width, known.height, 480, 320).height + 24
        : 340; // unknown aspect — the historical flat card
    } else if (isAudioFile(attachment.fileName)) {
      attachmentEstimate += 56;
    } else {
      attachmentEstimate += 40; // the file chip
    }
  }
  if (imageTiles > 0) {
    const tiles = Math.min(imageTiles, 10);
    // Mosaic rows: 1 → its real aspect box when known (~300 flat otherwise),
    // 2–3 → one row (~210), 4+ → a 2-column grid of square crops.
    attachmentEstimate += tiles === 1
      ? (singleImage !== null ? singleTileBox(480, singleImage.width, singleImage.height).height : 300)
      : tiles <= 3 ? 210 : Math.ceil(tiles / 2) * 220;
  }
  height += attachmentEstimate;
  return height;
}

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

interface ChatActions {
  replyTo: Message | null;
  setReplyTo(message: Message | null): void;
  beginEdit(message: Message): void;
  beginForward(messages: readonly Message[]): void;
  jumpTo(messageId: number): void;
  selectionMode: boolean;
  selection: ReadonlySet<number>;
  toggleSelected(messageId: number): void;
}

/** DMs are always fully writable — participants need no permission bits (oak parity). */
const DM_CHANNEL_PERMISSIONS: ChannelMyPermissions = { sendMessages: true, attachFiles: true };

/** Channel-shaped view over a DM row — the chat surface is channel-agnostic. */
function dmViewChannel(dm: DmChannel, selfUsername: string): Channel {
  return {
    id: dm.id,
    name: dmDisplayName(dm, selfUsername),
    type: dm.type,
    createdAt: "",
    locked: false,
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

export function ChatPane({ session }: { session: ConnectionSession }): React.JSX.Element {
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
  const draftOrigin = useMemo(
    () => openDiscussionEntry !== null && isDiscussionDraft
      ? session.messageStore.listFor(openDiscussionEntry.channelId)
          .find((message) => message.id === openDiscussionEntry.originMessageId) ?? null
      : null,
    [openDiscussionEntry, isDiscussionDraft, session],
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
  const [editing, setEditing] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [picker, setPicker] = useState<{ message: Message; x: number; y: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // Any pointer press outside the picker (or Escape) closes it — it must not
  // hang over the chat until a reaction is picked (live M7 polish report).
  useOutsideDismiss(pickerRef, () => setPicker(null));
  const [forwardQueue, setForwardQueue] = useState<readonly Message[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [staged, setStaged] = useState<readonly StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
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
    if (channelPermissions?.attachFiles === false) {
      return; // no ATTACH_FILES — staging stays empty, the gate line explains
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
  const viewChannel = dm !== null ? dmViewChannel(dm, ownUsername) : channel;
  const activeAround = useStore(appStore, (state) => state.activeAround);
  // The around target only applies to THIS chat (a search hit in another channel
  // first switches the channel; the field then survives into the new mount).
  const aroundTarget = activeAround !== null && viewChannel !== null && activeAround.channelId === viewChannel.id
    ? activeAround.messageId
    : null;
  const permissions = dm !== null ? DM_CHANNEL_PERMISSIONS : channelPermissions;
  const chatTitlePrefix = dm !== null && dm.type === "DM" ? "@" : "#";
  // The chat-surface binding while a discussion is open: a Channel-shaped adapter over the
  // discussion channel (id is all the send/reaction paths need; permissions resolve through
  // the parent server-side, so the parent's composer bits apply as-is).
  const chatChannel: Channel = openDiscussionEntry !== null && openDiscussionEntry.discussionId !== null
    ? { id: openDiscussionEntry.discussionId, name: "Discussion", type: "TEXT", createdAt: "", locked: false }
    : viewChannel!; // the null viewChannel dead-ends above (chat-empty) before this line

  const exitSelection = () => {
    setSelectionMode(false);
    setSelection(new Set());
  };

  if (viewChannel === null) {
    // Two dead ends, two messages: channels EXIST but every one is locked for
    // this viewer (a role pull) vs a server with no text channels at all.
    const anyVisible = channels.some((entry) => entry.type === "TEXT");
    return (
      <div className="chat-pane">
        <div className="chat-empty">
          {anyVisible
            ? "You have no permission to watch this chat."
            : "No text channel — pick one in the sidebar or create it with +."}
        </div>
      </div>
    );
  }

  const actions: ChatActions = {
    replyTo,
    setReplyTo,
    beginEdit: (message) => setEditing(message),
    beginForward: (list) => setForwardQueue(list),
    jumpTo: () => undefined, // MessageList replaces this with its scroll/backfill wiring
    selectionMode,
    selection,
    toggleSelected: (messageId) => {
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
  };

  return (
    <div
      className={"chat-pane" + (dragOver ? " drag-over" : "")}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        addStagedFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="chat-header">
        {dm === null
          ? <span className="icon mdi-pound" />
          : <span className="channel-hash">@</span>}
        {" "}{viewChannel.name}
        {selectionMode ? (
          <div className="selection-bar">
            <span>{selection.size} selected</span>
            <button className="ghost" disabled={selection.size === 0}
              onClick={() => setForwardQueue(messages.filter((message) => selection.has(message.id)))}>Forward</button>
            <button className="danger" disabled={selection.size === 0}
              onClick={() => {
                for (const messageId of selection) {
                  void session.deleteMessage(chatChannel.id, messageId).catch((error: unknown) => {
                    log.warn("chat", `bulk delete failed: ${error instanceof Error ? error.message : String(error)}`);
                  });
                }
                exitSelection();
              }}>Delete</button>
            <button className="ghost" onClick={exitSelection}>Cancel</button>
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
          draftOrigin={null}
          onCloseRequest={() => setCloseDiscussionTarget(openDiscussionRow)}
        />
      ) : null}
      {isDiscussionDraft && draftOrigin !== null ? (
        <DiscussionOriginPanel session={session} discussion={null} draftOrigin={draftOrigin} onCloseRequest={() => undefined} />
      ) : null}
      <NowPlayingBar session={session} />
      {isDiscussionDraft ? (
        <div className="discussion-draft-hint">
          The discussion starts with your first message — nothing is created until you send it.
        </div>
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
          <span>Replying to <strong>@{nameOf(replyTo.authorUsername)}</strong></span>
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
              <span className="file-name">Uploading…</span>
            </div>
          ) : null}
          {capNote !== null ? <div className="staging-skip-note">{capNote}</div> : null}
        </div>
      ) : null}
      {/* oak's applyComposerGating: without SEND_MESSAGES the whole card disappears
          (no gate line); without ATTACH_FILES only the paperclip hides (the composer
          itself stays). DMs are always fully writable. */}
      {permissions !== null && permissions.sendMessages ? (
        <Composer
          session={session}
          placeholder={`Message ${chatTitlePrefix}${viewChannel.name}${permissions.attachFiles ? " — paste or drop files to attach" : ""}`}
          attachEnabled={permissions.attachFiles}
          allowEmptySend={staged.length > 0}
          onCancelReply={replyTo !== null ? () => setReplyTo(null) : null}
          onPaste={(files) => addStagedFiles(files)}
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
            openPicker: () => setPicker({ message: menu.message, x: menu.x, y: menu.y + 120 }),
            confirmDelete: () => setDeleteTarget(menu.message),
            isDm: dm !== null,
            canStartDiscussion: dm === null && openDiscussionEntry === null && (channelPermissions?.sendMessages ?? false),
            canReact: dm !== null || session.permissionStore.can("ADD_REACTIONS"),
          })}
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
            <div className="reacted-by-name">Nobody yet</div>
          ) : (
            reactedBy.names.map((name) => <div key={name} className="reacted-by-name">{name}</div>)
          )}
        </div>
      ) : null}
      {picker !== null ? (
        <div
          ref={pickerRef}
          className="emoji-picker"
          style={{
            // Clamp by the picker's REAL footprint (the whole catalog in one
            // row) — a fixed 340px left it clipped by the window's right edge.
            left: Math.max(8, Math.min(picker.x, window.innerWidth - (REACTION_CATALOG.length * 42 + 16))),
            top: Math.min(Math.max(8, picker.y), window.innerHeight - 56),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {REACTION_CATALOG.map((entry) => {
            const summary = picker.message.reactions.find((candidate) => candidate.reaction === entry.slug);
            const selfId = session.selfUserId();
            const mine = selfId !== null && (summary?.userIds.includes(selfId) ?? false);
            return (
              <button key={entry.slug} className="emoji-choice"
                onClick={() => {
                  // A failed toggle (revoked permission, network) must leave a
                  // trace — the silent catch made 403s look like dead buttons.
                  void session.toggleReaction(chatChannel.id, picker.message.id, entry.slug, mine)
                    .catch((reactionError) => log.warn("reactions", `toggle ${entry.slug} failed: ${String(reactionError)}`));
                  setPicker(null);
                }}>
                {entry.glyph}
              </button>
            );
          })}
        </div>
      ) : null}
      {forwardQueue !== null ? (
        <ForwardDialog session={session} source={forwardQueue} sourceChannel={viewChannel} onClose={() => setForwardQueue(null)} />
      ) : null}
      {deleteTarget !== null ? (
        <Modal title="Delete message?" onClose={() => setDeleteTarget(null)}>
          <div className="modal-note">This cannot be undone.</div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="danger" onClick={() => {
              void session.deleteMessage(deleteTarget.channelId, deleteTarget.id).catch(() => undefined);
              setDeleteTarget(null);
            }}>Delete</button>
          </div>
        </Modal>
      ) : null}
      {closeDiscussionTarget !== null ? (
        <Modal title="Close discussion?" onClose={() => setCloseDiscussionTarget(null)}>
          <div className="modal-note">
            This closes the discussion for everyone and permanently removes its messages.
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setCloseDiscussionTarget(null)}>Cancel</button>
            <button className="danger" onClick={() => {
              closeDiscussionForEveryone(closeDiscussionTarget.id);
              setCloseDiscussionTarget(null);
            }}>Close</button>
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
): ContextMenuItem[] {
  const ownUsername = session.username();
  const canManageMessages = session.permissionStore.can("MANAGE_MESSAGES");
  const items: ContextMenuItem[] = [];
  // Gate SYMMETRY with the hover button (canAddReactions): a member without
  // ADD_REACTIONS must not see a context-menu path the server will 403 (live
  // report: the menu item opened the picker, the pick silently did nothing).
  if (extra.canReact) {
    items.push({ label: "Add reaction…", action: extra.openPicker });
  }
  items.push({ label: "Reply", action: () => actions.setReplyTo(message) });
  if ((message.content?.length ?? 0) > 0) {
    items.push({ label: "Copy text", action: () => void navigator.clipboard.writeText(message.content ?? "").catch(() => undefined) });
  }
  // Discord's pin gate: MANAGE_MESSAGES on server channels, ANY participant in a DM
  // (the server's DM branch enforces the same). A 400 means the per-channel cap.
  if (extra.isDm || canManageMessages) {
    items.push({
      label: message.pinned ? "Unpin" : "Pin",
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
      items.push({ label: "Open discussion", action: () => openDiscussion(existing) });
    } else {
      items.push({
        label: "Start a discussion",
        action: () => openDraftDiscussion({ channelId: message.channelId, messageId: message.id }),
      });
    }
  }
  if (message.authorUsername === ownUsername) {
    items.push({ label: "Edit", action: () => actions.beginEdit(message) });
  }
  items.push({ label: "Forward", action: () => actions.beginForward([message]) });
  if (!actions.selectionMode) {
    items.push({ label: "Select messages", action: extra.beginSelection });
  }
  if (message.authorUsername === ownUsername || canManageMessages) {
    items.push({ label: "Delete", danger: true, action: extra.confirmDelete });
  }
  return items;
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

function MessageList(props: MessageListProps): React.JSX.Element {
  const { session, channel, messages, aroundTarget, actions, editing } = props;
  const listRef = useRef<VirtualListHandle | null>(null);
  const nearBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const hasOlderRef = useRef(true);
  const pendingJumpRef = useRef<number | null>(null);
  const firstLayoutRef = useRef(true);
  // The around window's downward end: true while an id-unknown gap sits between the
  // window's last message and the live tail (the search jump opened mid-history).
  const belowEndRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [jumpToPresent, setJumpToPresent] = useState(false);
  const [dividerReadId, setDividerReadId] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [beginReached, setBeginReached] = useState(false);
  // One settling-jump ladder at a time — a new jump cancels the previous
  // ladder's re-assertions (two ladders would fight over the viewport).
  const settlingJumpCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => settlingJumpCancelRef.current?.(), []);

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
  }, [channel.id, session]);

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
    appStore.patch({ activeAround: null }); // consumed — a later channel re-entry must not re-jump
    firstLayoutRef.current = false; // the window IS the layout — no divider/bottom open
    const around = session.messageStore.isAroundWithoutTail(channel.id);
    belowEndRef.current = around;
    setJumpToPresent(around);
    settlingJumpCancelRef.current?.();
    settlingJumpCancelRef.current = scheduleSettlingJump(listRef, String(aroundTarget), () => {
      // Re-flash with every re-assertion: the row may only ENTER the viewport
      // on a late attempt, when the original highlight is long gone.
      setHighlightId(aroundTarget);
      window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aroundTarget, messages]);

  // oak's BeginOfChannel latch: a short initial page IS the whole history — the
  // marker rides above everything without a guaranteed-empty pagination probe.
  useEffect(() => {
    if (!beginReached && hasOlderRef.current && !loadingOlderRef.current
      && messages.length > 0 && messages.length < HISTORY_PAGE) {
      hasOlderRef.current = false;
      setBeginReached(true);
    }
  }, [messages, beginReached]);

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
        if (index > 0) {
          listRef.current?.scrollToKey(String(messages[index]?.id), "center");
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
  useEffect(() => {
    const grew = messages.length > messageCountRef.current;
    const pinned = nearBottomRef.current;
    const watching = pinned && document.hasFocus();
    const ownBatch = previousTailRef.current !== null
      && messages.filter((message) => message.id > previousTailRef.current!)
        .every((message) => message.authorUsername === session.username());
    // While an around window is paginating DOWN, the "new" rows below are OLD
    // messages fetched on demand — not unread arrivals. No divider raise, no ack;
    // scrollToBottom stays (it chains the next downward page while pinned).
    if (grew && previousTailRef.current !== null && !watching && !ownBatch && !belowEndRef.current) {
      setDividerReadId(previousTailRef.current);
    }
    previousTailRef.current = messages.length > 0 ? messages[messages.length - 1]!.id : null;
    messageCountRef.current = messages.length;
    if (grew && pinned) {
      listRef.current?.scrollToBottom();
    }
    if (grew && (watching || ownBatch) && !belowEndRef.current) {
      ackActiveChannel();
    }
  }, [messages]);

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
    settlingJumpCancelRef.current = scheduleSettlingJump(listRef, String(target), () => {
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
        const lastId = messages[messages.length - 1]!.id;
        const raw = await session.loadNewer(channel.id, lastId);
        if (raw < NEWER_PAGE) {
          belowEndRef.current = false;
          setJumpToPresent(false);
          session.messageStore.markTailReached(channel.id);
          if (nearBottomRef.current && document.hasFocus()) {
            ackActiveChannel(); // contiguous tail now — the ack is finally true
          }
        }
      } catch {
        // next near-bottom pass retries
      } finally {
        loadingNewerRef.current = false;
      }
    })();
  };

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
      .catch(() => undefined);
  };

  const wiredActions: ChatActions = {
    ...actions,
    jumpTo: (messageId: number) => {
      if (messages.some((message) => message.id === messageId)) {
        settlingJumpCancelRef.current?.();
        settlingJumpCancelRef.current = scheduleSettlingJump(listRef, String(messageId), () => {
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
          notifications.showToast({ title: "space", channelName: "", body: "Message is too far back to jump to" });
        }
      })().catch(() => undefined);
    },
  };

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
    (message: Message): number => estimateRowHeight(message, startById.get(message.id) ?? true,
      discussionOriginIds.has(message.id), emojiJumboSize),
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
      itemKey={(message) => String(message.id)}
      estimateHeight={groupedEstimateHeight}
      onNearTop={loadOlder}
      onBottomProximity={(nearBottom) => {
        nearBottomRef.current = nearBottom;
        if (nearBottom) {
          scheduleDividerDismiss(); // back at the bottom → restart the countdown
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
            <div className="begin-marker">Beginning of history</div>
          ) : null}
          {index === dividerIndex ? (
            <div
              className="new-messages-divider"
              title="Jump to the first unread message"
              onClick={(event) => {
                event.stopPropagation();
                const firstUnread = messages[dividerIndex];
                if (firstUnread !== undefined) {
                  wiredActions.jumpTo(firstUnread.id);
                }
              }}
            >
              <span>↓ New messages ↓</span>
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
      {jumpToPresent && messages.length > 0 ? (
        <button className="jump-to-present" onClick={jumpToPresentNow}>Jump To Present ↓</button>
      ) : null}
    </>
  );
}

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
 * Memoized: the VirtualList recomputes its window on every scroll frame, which
 * re-runs renderItem for the whole visible window — with memo, rows whose props
 * are unchanged (the overwhelming case while scrolling) skip re-rendering
 * entirely; only rows entering/leaving the window actually mount/unmount.
 */
const MessageRow = memo(function MessageRow(props: MessageRowProps): React.JSX.Element {
  const { session, channel, message, startsGroup, editing, highlighted, selected, actions } = props;
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
      : undefined).catch(() => undefined);
    props.setEditing(null);
  };

  // oak's canAddReactions: DM participants always may; server channels need ADD_REACTIONS.
  const dmContext = channel.type === "DM" || channel.type === "GROUP_DM";
  const canReact = dmContext || session.permissionStore.can("ADD_REACTIONS");

  const body = editing ? (
    <>
      <textarea
        className="inline-editor"
        autoFocus
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
          ? `${removedKeys.size} image${removedKeys.size > 1 ? "s" : ""} will be removed · enter to save · esc to cancel`
          : message.attachments.some((attachment) => isImageFile(attachment.fileName))
            ? "enter to save · esc to cancel · click × to remove an image"
            : "enter to save · esc to cancel"}
      </div>
    </>
  ) : (
    <div className="message-content">
      {(() => {
        // Computed once per render: the segments feed the mapping AND the jumbo
        // check (an emoji-only message renders its tokens large — Discord rule).
        const segments = segmentMessageContent(message.content, message.mentions, emojiNames);
        const emojiOnly = isEmojiOnlyMessage(segments);
        return segments.map((segment, segmentIndex) =>
          segment.kind === "mention"
            ? <span key={segmentIndex} className="mention">{segment.text}</span>
            : segment.kind === "link"
              ? (
                <a
                  key={segmentIndex}
                  className="body-link"
                  href={segment.url}
                  onClick={(event) => {
                    event.preventDefault(); // the app never navigates — the system browser opens
                    void window.spaceMedia?.openExternal(segment.url);
                  }}
                >
                  {segment.text}
                </a>
              )
              : segment.kind === "emoji"
                ? <InlineEmoji key={segmentIndex} session={session} name={segment.name} large={emojiOnly} />
                : <span key={segmentIndex}>{segment.text}</span>,
        );
      })()}
      {message.editedAt !== null ? <span className="message-edited">(edited)</span> : null}
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
  const previewUrl = firstHttpUrl(message.content); // oak: only the FIRST link gets a card

  return (
    <div
      className={"message-row"
        + (startsGroup ? " head" : " continuation")
        + (highlighted ? " highlighted" : "")
        + (selected ? " selected" : "")}
      onClick={() => {
        if (actions.selectionMode) {
          actions.toggleSelected(message.id);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!actions.selectionMode) {
          props.onMenu({ message, x: event.clientX, y: event.clientY });
        }
      }}
    >
      {/* oak's hover cluster, right to left: [react][reply][forward] — the react
          button hugs the scrollbar clearance, forward sits leftmost (Java-checked). */}
      {!actions.selectionMode ? (
        <div className="message-hover-buttons">
          <button
            className="hover-button"
            title="Forward"
            onClick={(event) => {
              event.stopPropagation();
              actions.beginForward([message]);
            }}
          >
            <span className="icon mdi-forward" />
          </button>
          <button
            className="hover-button"
            title="Reply"
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
              title="Add reaction"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                props.onPicker({ message, x: rect.left, y: rect.bottom + 4 });
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
            <span className="message-time">{formatHeaderStamp(toEpochMs(message.createdAt), Date.now(), relativeDates)}</span>
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
          </ForwardCard>
        ) : (
          <>
            {message.reply !== null
              ? <QuoteCard level={message.reply} depth={0} clickable onJump={actions.jumpTo} nameOf={nameOf} />
              : null}
            {body}
            {previewUrl !== null ? <LinkPreviewCard url={previewUrl} /> : null}
            {attachmentView}
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
                  {REACTION_GLYPH_BY_SLUG[summary.reaction] ?? summary.reaction} {summary.count}
                </button>
              );
            })}
          </div>
        ) : null}
        {props.discussion !== undefined ? (
          <button
            className="message-discussion-tile"
            title="Open the discussion on this message"
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
 * The origin panel of an OPEN discussion (the pin-card slot): the frozen start-message
 * snapshot (author nick through the live roster, snippet, time) with the thread's controls —
 * back to the channel, Follow/Unfollow, and Close (MANAGE_MESSAGES, behind a confirm —
 * closes for everyone). The DRAFT variant (lazy creation) renders the origin straight from
 * the parent channel's own message list and carries no controls — the thread does not
 * exist server-side until the first reply.
 */
function DiscussionOriginPanel({ session, discussion, draftOrigin, onCloseRequest }: {
  session: ConnectionSession;
  discussion: Discussion | null;
  draftOrigin: Message | null;
  onCloseRequest(): void;
}): React.JSX.Element | null {
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const trackedVersion = useStore(session.discussionsStore, (store) => store.version);
  void trackedVersion; // the row below is read imperatively; this re-renders on flips
  const row = discussion !== null ? session.discussionsStore.byId(discussion.id) ?? discussion : null;
  const canManageMessages = session.permissionStore.can("MANAGE_MESSAGES");
  if (row === null) {
    // The draft: the origin comes from the parent's own loaded list.
    if (draftOrigin === null) {
      return null;
    }
    return (
      <div className="discussion-origin-panel">
        <button className="discussion-origin-back" title="Back to the channel" onClick={() => closeDiscussionView()}>
          <span className="icon mdi-arrow-left" />
        </button>
        <div className="discussion-origin-body">
          <div className="discussion-origin-author">
            {displayNameOf(rosterUsers, draftOrigin.authorUsername)}
            <span className="discussion-origin-time">
              {formatHeaderStamp(new Date(draftOrigin.createdAt).getTime(), Date.now())}
            </span>
          </div>
          <div className="discussion-origin-snippet">{draftOrigin.content || "(attachment)"}</div>
        </div>
        <div className="discussion-origin-draft-tag">draft</div>
      </div>
    );
  }
  const originTime = row.originCreatedAt !== null
    ? formatHeaderStamp(new Date(row.originCreatedAt).getTime(), Date.now())
    : null;
  return (
    <div className="discussion-origin-panel">
      <button
        className="discussion-origin-back"
        title="Back to the channel"
        onClick={() => closeDiscussionView()}
      >
        <span className="icon mdi-arrow-left" />
      </button>
      <div className="discussion-origin-body">
        <div className="discussion-origin-author">
          {displayNameOf(rosterUsers, row.originAuthorName)}
          {originTime !== null ? <span className="discussion-origin-time">{originTime}</span> : null}
        </div>
        <div className="discussion-origin-snippet">{row.originSnippet || "(attachment)"}</div>
      </div>
      <div className="discussion-origin-actions">
        <button
          className="discussion-origin-action"
          title={row.tracked ? "Unfollow discussion" : "Follow discussion"}
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
            title="Close discussion for everyone"
            onClick={onCloseRequest}
          >
            <span className="icon mdi-close" />
          </button>
        ) : null}
      </div>
    </div>
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
  if (level.deleted) {
    return <div className="quote-card deleted">Original message deleted</div>;
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
        <span className="quote-prefix">Reply to</span>
        <span className="quote-author" style={{ color: paletteColor(level.authorUsername) }}>{nameOf(level.authorUsername)}</span>
      </div>
      {level.forward !== null ? <span className="quote-forward">↗ from {nameOf(level.forward.authorUsername)}</span> : null}
      {level.reply !== null && depth < QUOTE_DEPTH_MAX
        ? <QuoteCard level={level.reply} depth={depth + 1} clickable={clickable} onJump={onJump} nameOf={nameOf} />
        : null}
      <span className="quote-preview">{level.preview}</span>
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
  // Subscribed like MessageList: a relative-dates toggle repaints the stamp.
  const relativeDates = useStore(settingsStore, (settings) => settings.relativeDates);
  return (
    <div className="forward-card">
      <div className="forward-head">
        <span className="icon mdi-forward" />
        <span className="forward-prefix">Forwarded from</span>
        <span className="forward-origin">{forward.serverName} → #{forward.channelName}</span>
        {!forward.trusted ? <span className="forward-unverified"> · unverified</span> : null}
      </div>
      <div className="forward-author-row">
        <span className="forward-author" style={{ color: paletteColor(forward.authorUsername) }}>{nameOf(forward.authorUsername)}</span>
        <span className="forward-time">{formatHeaderStamp(toEpochMs(forward.createdAt), Date.now(), relativeDates)}</span>
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

function Composer({ session, placeholder, attachEnabled, allowEmptySend, onCancelReply, onPaste, onSend }: {
  session: ConnectionSession;
  placeholder: string;
  attachEnabled: boolean;
  allowEmptySend: boolean;
  /** oak: ESC in the field cancels an armed reply (consumed so the field keeps focus); null = nothing armed. */
  onCancelReply: (() => void) | null;
  onPaste(files: readonly File[]): void;
  onSend: (content: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{ token: string; caret: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState("");
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const users = useStore(session.rosterStore, (state) => state.users);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const ctrlEnterSends = useStore(settingsStore, (settings) => settings.ctrlEnterSends);
  const emojiState = useStore(session.emojiStore, (state) => state);
  const emojiMatches = useMemo(() => filterEmojis(emojiState.emojis, emojiQuery), [emojiState.emojis, emojiQuery]);

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
    const replaced = `${text.slice(0, start)}@${insert} ${text.slice(mentionQuery.caret)}`;
    setText(replaced);
    setMentionQuery(null);
    // A MOUSE click on a suggestion row moved the focus out of the field — the
    // user expects to keep typing (or press Enter) right away (live report).
    // rAF: let the re-render land first, then place the caret after the insert.
    const caret = start + insert.length + 2; // after "@name "
    window.requestAnimationFrame(() => {
      const node = composerInputRef.current;
      if (node !== null) {
        node.focus();
        node.setSelectionRange(caret, caret);
      }
    });
  };

  /** Inserts ":name:" at the caret (the applyMention mechanic: rAF refocus so a
   *  mouse click on the grid doesn't steal the typing flow). The picker STAYS
   *  open — Discord's behavior — until Escape/outside-click closes it. */
  const applyEmoji = (name: string): void => {
    const node = composerInputRef.current;
    const caret = node !== null ? node.selectionStart ?? text.length : text.length;
    const replaced = `${text.slice(0, caret)}:${name}:${text.slice(caret)}`;
    setText(replaced);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      const field = composerInputRef.current;
      if (field !== null) {
        field.focus();
        const nextCaret = caret + name.length + 2;
        field.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  // The BUTTON rides as the popup's anchor: its own press does not count as
  // "outside", so the onClick toggle closes the picker instead of racing the
  // outside-dismiss into a reopen (live report).
  useOutsideDismiss(emojiPickerRef, () => {
    if (emojiPickerOpen) {
      setEmojiPickerOpen(false);
      setEmojiQuery("");
    }
  }, emojiButtonRef);

  const submit = async (): Promise<void> => {
    const content = text.trim();
    if ((!content && !allowEmptySend) || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSend(content);
      setText("");
      setMentionQuery(null);
      // A sent message closes the picker (user request) — but a FAILED send
      // keeps it: the draft survives, so does the picker.
      setEmojiPickerOpen(false);
      setEmojiQuery("");
    } catch (submitError) {
      // Keep the text — a failed send must never eat the draft.
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
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
      {emojiPickerOpen && emojiState.supported ? (
        <div ref={emojiPickerRef} className="emoji-popup">
          <input
            className="emoji-popup-search"
            type="text"
            placeholder="Search emojis"
            value={emojiQuery}
            onChange={(event) => setEmojiQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation(); // the textarea's own Escape handlers stay quiet
                setEmojiPickerOpen(false);
                setEmojiQuery("");
              }
            }}
          />
          {emojiMatches.length === 0 ? (
            <div className="emoji-popup-empty">
              {emojiState.emojis.length === 0
                ? "No emojis yet — upload them in Server Settings."
                : "Nothing matches."}
            </div>
          ) : (
            <div className="emoji-popup-grid">
              {emojiMatches.map((emoji) => (
                <EmojiTile key={emoji.id} session={session} emoji={emoji} onPick={() => applyEmoji(emoji.name)} />
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className="composer-card">
        {/* oak's applyComposerGating: without ATTACH_FILES the paperclip HIDES
            (never disables); the composer itself stays. Glyph = Icons.attach(). */}
        {attachEnabled ? (
          <button
            className="composer-attach"
            title="Attach files"
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
        <textarea
          ref={composerInputRef}
          value={text}
          rows={Math.min(10, Math.max(1, text.split("\n").length))}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            updateMentionQuery(event.target.value, event.target.selectionStart);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (attachEnabled && files.length > 0) {
              event.preventDefault();
              onPaste(files);
            }
          }}
          onKeyDown={(event) => {
          if (event.key === "Escape" && onCancelReply !== null) {
            event.preventDefault();
            onCancelReply();
            return;
          }
          if (mentionQuery !== null && mentionCandidates.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((index) => (index + 1) % mentionCandidates.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex((index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              applyMention(mentionCandidates[mentionIndex]!.insert);
              return;
            }
            if (event.key === "Escape") {
              setMentionQuery(null);
              return;
            }
          }
          // Enter semantics are SETTINGS-OWNED (M7): default Enter sends and
          // Ctrl/Shift+Enter newline; with ctrlEnterSends the roles swap (Shift
          // stays a newline in both modes). Ctrl+Enter needs the manual insert —
          // Chromium treats it as non-text.
          const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey;
          const ctrlEnter = event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey;
          const shiftEnter = event.key === "Enter" && event.shiftKey && !event.altKey;
          const sendOnThisEnter = ctrlEnterSends ? ctrlEnter : plainEnter;
          const newlineOnThisEnter = ctrlEnterSends ? plainEnter || shiftEnter : ctrlEnter || shiftEnter;
          if (sendOnThisEnter) {
            event.preventDefault();
            void submit();
          } else if (newlineOnThisEnter) {
            event.preventDefault();
            const textarea = event.currentTarget;
            textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
            setText(textarea.value);
          }
        }}
        />
        {/* The emoji button sits at the card's RIGHT edge (user request) — unlike
            the paperclip it is not ATTACH_FILES-gated: picker access needs no
            permission, only the server supporting the catalog. */}
        {emojiState.supported ? (
          <button
            ref={emojiButtonRef}
            className="composer-attach"
            title="Emoji"
            onClick={() => {
              setEmojiPickerOpen((open) => !open);
              setEmojiQuery("");
              setMentionQuery(null); // the two popups are mutually exclusive
            }}
          ><span className="icon mdi-emoticon" /></button>
        ) : null}
      </div>
      {/* No hint line under the card (oak has none) — the composer's bottom
          inset matches the left overlay card's, so the two read as a pair.
          The error line only exists while a send actually failed. */}
      {error !== null ? <div className="composer-error">{error}</div> : null}
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
          // dimensions stay valid and ride along.
          const targetAttachments: { key: string; fileName: string; width: number | null; height: number | null }[] = [];
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
            });
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
    <Modal title={`Forward ${source.length === 1 ? "message" : `${source.length} messages`}`} onClose={onClose}>
      <div className="forward-picker">
        <div className="forward-column">
          <div className="forward-column-title">Server</div>
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
          <div className="forward-column-title">Channel</div>
          {targetChannels === null ? <div className="forward-note">Loading channels…</div> : null}
          {targetChannels?.length === 0 ? <div className="forward-note">No text channels.</div> : null}
          {targetChannels?.map((entry) => (
            <div key={entry.id}
              className={"forward-row" + (entry.id === targetChannelId ? " chosen" : "")}
              onClick={() => setTargetChannelId(entry.id)}>
              # {entry.name}
            </div>
          ))}
        </div>
      </div>
      <input type="text" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment (optional)" />
      {crossInstance && hasAttachments ? (
        <div className="modal-note">Attachments are re-uploaded to the target server — this may take a while.</div>
      ) : null}
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || targetChannelId === null} onClick={() => void submit()}>Forward</button>
      </div>
    </Modal>
  );
}
