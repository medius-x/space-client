import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { ackActiveChannel, appStore, forwardCrossInstance, forwardRequestUpload, forwardUploadBytes } from "../runtime";
import { connectionDirectory, settingsStore } from "../runtime";
import { RecordTokenStorage } from "../../domain/session/connection-record";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { HISTORY_PAGE } from "../../domain/session/connection-session";
import { RestClient } from "../../core/rest";
import { log } from "../../logging";
import { computeGroupStarts, continuesGroup, formatHeaderStamp, formatTimeOfDay, toEpochMs, type GroupableMessage } from "../../domain/logic/message-grouping";
import { firstHttpUrl, segmentMessageContent } from "../../domain/logic/mention-segmenter";
import { displayNameOf } from "../../domain/logic/display-name";
import { linkPreviewFor, type LinkPreview } from "../link-preview";
import { notifications } from "../notifications";
import { dmDisplayName } from "../../domain/logic/dm-display";
import { memberNameColor } from "../../domain/logic/roster-grouping";
import { paletteColor } from "../../domain/logic/user-palette";
import type { Channel, ChannelMyPermissions, DmChannel, ForwardInfo, Message, ReplyInfo } from "../../types";
import { REACTION_CATALOG, REACTION_GLYPH_BY_SLUG } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { AttachmentView } from "./AttachmentView";
import { isAudioFile, isImageFile, isVideoFile } from "../../domain/logic/attachment-layout";
import { Avatar } from "./Avatar";
import { NowPlayingBar } from "./NowPlayingBar";

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
function estimateRowHeight(message: Message, startsGroup: boolean): number {
  const CHARS_PER_LINE = 72;
  const lines = message.content === null ? 0 : Math.max(1, Math.ceil(message.content.length / CHARS_PER_LINE));
  let height = (startsGroup ? 30 : 24) + lines * 21;
  if (message.reply !== null) {
    height += 34;
  }
  if (message.forward !== null) {
    height += 30;
  }
  if (message.reactions.length > 0) {
    height += 26;
  }
  // Media-aware attachment estimate (live report: a flat +22 made every
  // picture/video row JUMP on measure — the real mosaic is 200-500px, and the
  // estimate→fact delta shifted everything below it). Rough by design: the
  // natural image size is unknown before the decode; the point is the ORDER
  // of magnitude, not the pixel.
  let attachmentEstimate = 0;
  let imageTiles = 0;
  for (const attachment of message.attachments) {
    if (isImageFile(attachment.fileName)) {
      imageTiles += 1;
    } else if (isVideoFile(attachment.fileName)) {
      attachmentEstimate += 340; // the card: preview capped at 320 high + name
    } else if (isAudioFile(attachment.fileName)) {
      attachmentEstimate += 56;
    } else {
      attachmentEstimate += 40; // the file chip
    }
  }
  if (imageTiles > 0) {
    const tiles = Math.min(imageTiles, 10);
    // Mosaic rows: 1 → a bounded square (~300), 2–3 → one row (~210),
    // 4+ → a 2-column grid of square crops.
    attachmentEstimate += tiles === 1 ? 300 : tiles <= 3 ? 210 : Math.ceil(tiles / 2) * 220;
  }
  height += attachmentEstimate;
  return height;
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
  const messages = useStore(session.messageStore, (store) => store.listFor(activeChatId ?? -1));
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
    session.loadHistory(activeChatId).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : String(error));
    });
    if (dm === null) {
      session.ensureChannelPermissions(activeChatId).catch((error: unknown) => {
        log.warn("chat", `permission check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
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
  const permissions = dm !== null ? DM_CHANNEL_PERMISSIONS : channelPermissions;
  const chatTitlePrefix = dm !== null && dm.type === "DM" ? "@" : "#";

  const exitSelection = () => {
    setSelectionMode(false);
    setSelection(new Set());
  };

  if (viewChannel === null) {
    return (
      <div className="chat-pane">
        <div className="chat-empty">No text channel — pick one in the sidebar or create it with +.</div>
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
                  void session.deleteMessage(viewChannel.id, messageId).catch((error: unknown) => {
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
      <NowPlayingBar session={session} />
      <MessageList
        session={session}
        channel={viewChannel}
        messages={messages}
        actions={actions}
        authorColor={authorColor}
        editing={editing}
        setEditing={setEditing}
        onMenu={setMenu}
        onPicker={setPicker}
        onReactedBy={setReactedBy}
      />
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
            const promise = files.length > 0
              ? session.sendMessageWithFiles(viewChannel.id, files, content.length > 0 ? content : null, replyTo?.id)
              : session.sendMessage(viewChannel.id, content, replyTo?.id);
            const clearing = promise.then(() => {
              setStaged([]);
              setCapNote(null);
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
                  void session.toggleReaction(viewChannel.id, picker.message.id, entry.slug, mine).catch(() => undefined);
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
              void session.deleteMessage(viewChannel.id, deleteTarget.id).catch(() => undefined);
              setDeleteTarget(null);
            }}>Delete</button>
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
  },
): ContextMenuItem[] {
  const ownUsername = session.username();
  const canManageMessages = session.permissionStore.can("MANAGE_MESSAGES");
  const items: ContextMenuItem[] = [
    { label: "Add reaction…", action: extra.openPicker },
    { label: "Reply", action: () => actions.setReplyTo(message) },
  ];
  if ((message.content?.length ?? 0) > 0) {
    items.push({ label: "Copy text", action: () => void navigator.clipboard.writeText(message.content ?? "").catch(() => undefined) });
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
  actions: ChatActions;
  authorColor(username: string): string | null;
  editing: Message | null;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
  onReactedBy(state: { x: number; y: number; names: readonly string[] }): void;
}

function MessageList(props: MessageListProps): React.JSX.Element {
  const { session, channel, messages, actions, editing } = props;
  const listRef = useRef<VirtualListHandle | null>(null);
  const nearBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const hasOlderRef = useRef(true);
  const pendingJumpRef = useRef<number | null>(null);
  const firstLayoutRef = useRef(true);
  const [dividerReadId, setDividerReadId] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [beginReached, setBeginReached] = useState(false);

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
  }, [channel.id, session]);

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
    if (grew && previousTailRef.current !== null && !watching && !ownBatch) {
      setDividerReadId(previousTailRef.current);
    }
    previousTailRef.current = messages.length > 0 ? messages[messages.length - 1]!.id : null;
    messageCountRef.current = messages.length;
    if (grew && pinned) {
      listRef.current?.scrollToBottom();
    }
    if (grew && (watching || ownBatch)) {
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
    for (let attempt = 0; attempt < 4; attempt++) {
      window.setTimeout(() => listRef.current?.scrollToKey(String(target), "center"), 30 * attempt);
    }
    setHighlightId(target);
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
    return () => window.clearTimeout(timer);
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

  const wiredActions: ChatActions = {
    ...actions,
    jumpTo: (messageId: number) => {
      if (messages.some((message) => message.id === messageId)) {
        setHighlightId(messageId);
        window.setTimeout(() => setHighlightId(null), HIGHLIGHT_TTL_MS);
        for (let attempt = 0; attempt < 4; attempt++) {
          window.setTimeout(() => listRef.current?.scrollToKey(String(messageId), "center"), 30 * attempt);
        }
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
  const groupedEstimateHeight = useCallback(
    (message: Message): number => estimateRowHeight(message, startById.get(message.id) ?? true),
    [startById],
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
            actions={wiredActions}
            setEditing={props.setEditing}
            onMenu={props.onMenu}
            onPicker={props.onPicker}
            onReactedBy={props.onReactedBy}
          />
        </>
      )}
    />
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
  actions: ChatActions;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
  onReactedBy(state: { x: number; y: number; names: readonly string[] }): void;
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
      {segmentMessageContent(message.content, message.mentions).map((segment, segmentIndex) =>
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
            : <span key={segmentIndex}>{segment.text}</span>,
      )}
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
                  onClick={() => void session.toggleReaction(channel.id, message.id, summary.reaction, mine).catch(() => undefined)}
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
      </div>
    </div>
  );
});

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const users = useStore(session.rosterStore, (state) => state.users);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const ctrlEnterSends = useStore(settingsStore, (settings) => settings.ctrlEnterSends);

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
          const targetAttachments: { key: string; fileName: string }[] = [];
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
            targetAttachments.push({ key: targetSlot.key, fileName: attachment.fileName });
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
