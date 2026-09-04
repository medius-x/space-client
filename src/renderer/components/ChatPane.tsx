import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { ackActiveChannel, appStore, forwardCrossInstance, forwardRequestUpload, forwardUploadBytes } from "../runtime";
import { connectionDirectory } from "../runtime";
import { RecordTokenStorage } from "../../domain/session/connection-record";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { HISTORY_PAGE } from "../../domain/session/connection-session";
import { RestClient } from "../../core/rest";
import { log } from "../../logging";
import { computeGroupStarts, formatTimeOfDay, toEpochMs, type GroupableMessage } from "../../domain/logic/message-grouping";
import { segmentMessageContent } from "../../domain/logic/mention-segmenter";
import type { Channel, ForwardInfo, Message, ReplyInfo } from "../../types";
import { REACTION_CATALOG, REACTION_GLYPH_BY_SLUG } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { AttachmentView } from "./AttachmentView";
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
const DIVIDER_TTL_MS = 1600;
const HIGHLIGHT_TTL_MS = 1500;
const QUOTE_DEPTH_MAX = 5;

/**
 * Content-aware height estimate — the flatter the estimate, the more totalHeight
 * "breathes" when measurement replaces it, and a breathing scrollHeight makes the
 * scrollbar thumb drift off the cursor mid-drag (the mapping denominator moves).
 */
function estimateRowHeight(message: Message): number {
  const CHARS_PER_LINE = 72;
  const lines = message.content === null ? 0 : Math.max(1, Math.ceil(message.content.length / CHARS_PER_LINE));
  let height = 30 + lines * 21;
  if (message.reply !== null) {
    height += 34;
  }
  if (message.forward !== null) {
    height += 30;
  }
  if (message.reactions.length > 0) {
    height += 26;
  }
  if (message.attachments.length > 0) {
    height += 22;
  }
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

export function ChatPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const messages = useStore(session.messageStore, (store) => store.listFor(activeChannelId ?? -1));
  const channelPermissions = useStore(session.permissionStore, (state) =>
    activeChannelId === null ? null : state.channels.get(activeChannelId) ?? null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [picker, setPicker] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [forwardQueue, setForwardQueue] = useState<readonly Message[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [staged, setStaged] = useState<readonly StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (activeChannelId === null) {
      return;
    }
    setHistoryError(null);
    setReplyTo(null);
    setEditing(null);
    setSelectionMode(false);
    setSelection(new Set());
    setStaged([]);
    session.playback.stop(); // one sound at a time — leaving the channel silences it
    session.loadHistory(activeChannelId).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : String(error));
    });
    session.ensureChannelPermissions(activeChannelId).catch((error: unknown) => {
      log.warn("chat", `permission check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeChannelId, session]);

  const addStagedFiles = (fileList: readonly File[]) => {
    if (channelPermissions?.attachFiles === false) {
      return; // no ATTACH_FILES — staging stays empty, the gate line explains
    }
    setStaged((previous) => {
      const known = new Set(previous.map((entry) => `${entry.file.name}:${entry.file.size}`));
      const fresh: StagedFile[] = [];
      for (const file of fileList) {
        if (previous.length + fresh.length >= MAX_STAGED_FILES) {
          break;
        }
        const fingerprint = `${file.name}:${file.size}`;
        if (known.has(fingerprint)) {
          continue;
        }
        known.add(fingerprint);
        fresh.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file });
      }
      return fresh.length > 0 ? [...previous, ...fresh] : previous;
    });
  };

  // Focus-regain acks the open channel (oak's ack-on-focus).
  useEffect(() => {
    const onWindowFocus = () => ackActiveChannel();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, []);

  const channel = activeChannelId !== null
    ? channels.find((entry) => entry.id === activeChannelId) ?? null
    : null;

  const exitSelection = () => {
    setSelectionMode(false);
    setSelection(new Set());
  };

  if (channel === null) {
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
        <span className="channel-hash">#</span> {channel.name}
        {selectionMode ? (
          <div className="selection-bar">
            <span>{selection.size} selected</span>
            <button className="ghost" disabled={selection.size === 0}
              onClick={() => setForwardQueue(messages.filter((message) => selection.has(message.id)))}>Forward</button>
            <button className="danger" disabled={selection.size === 0}
              onClick={() => {
                for (const messageId of selection) {
                  void session.deleteMessage(channel.id, messageId).catch((error: unknown) => {
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
        channel={channel}
        messages={messages}
        actions={actions}
        editing={editing}
        setEditing={setEditing}
        onMenu={setMenu}
        onPicker={setPicker}
      />
      {replyTo !== null ? (
        <div className="reply-bar">
          <span>Replying to <strong>{replyTo.authorUsername}</strong></span>
          <span className="reply-preview">{(replyTo.content ?? "").slice(0, 80)}</span>
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
              }}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {channelPermissions === null ? (
        <div className="composer-gate">…</div>
      ) : channelPermissions.sendMessages ? (
        <Composer
          placeholder={`Message #${channel.name}${channelPermissions.attachFiles ? " — paste or drop files to attach" : ""}`}
          attachEnabled={channelPermissions.attachFiles}
          allowEmptySend={staged.length > 0}
          onPaste={(files) => addStagedFiles(files)}
          onSend={(content) => {
            const files = staged.map((entry) => entry.file);
            const promise = files.length > 0
              ? session.sendMessageWithFiles(channel.id, files, content.length > 0 ? content : null, replyTo?.id)
              : session.sendMessage(channel.id, content, replyTo?.id);
            const clearing = promise.then(() => {
              setStaged([]);
            });
            setReplyTo(null);
            return clearing;
          }}
        />
      ) : (
        <div className="composer-gate">You do not have permission to send messages in this channel.</div>
      )}

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
      {picker !== null ? (
        <div className="emoji-picker" style={{ left: Math.min(picker.x, window.innerWidth - 340), top: Math.min(picker.y, window.innerHeight - 60) }} onClick={(event) => event.stopPropagation()}>
          {REACTION_CATALOG.map((entry) => {
            const summary = picker.message.reactions.find((candidate) => candidate.reaction === entry.slug);
            const selfId = session.selfUserId();
            const mine = selfId !== null && (summary?.userIds.includes(selfId) ?? false);
            return (
              <button key={entry.slug} className="emoji-choice"
                onClick={() => {
                  void session.toggleReaction(channel.id, picker.message.id, entry.slug, mine).catch(() => undefined);
                  setPicker(null);
                }}>
                {entry.glyph}
              </button>
            );
          })}
        </div>
      ) : null}
      {forwardQueue !== null ? (
        <ForwardDialog session={session} source={forwardQueue} sourceChannel={channel} onClose={() => setForwardQueue(null)} />
      ) : null}
      {deleteTarget !== null ? (
        <Modal title="Delete message?" onClose={() => setDeleteTarget(null)}>
          <div className="modal-note">This cannot be undone.</div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="danger" onClick={() => {
              void session.deleteMessage(channel.id, deleteTarget.id).catch(() => undefined);
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
  editing: Message | null;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
  onPicker(state: { message: Message; x: number; y: number }): void;
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

  // Snapshot the unread divider at open (before the ack moves the pointer).
  useEffect(() => {
    const lastRead = session.readStateStore.get(channel.id).lastReadMessageId;
    setDividerReadId(lastRead);
    firstLayoutRef.current = true;
    hasOlderRef.current = true;
    if (lastRead !== null) {
      const timer = window.setTimeout(() => setDividerReadId(null), DIVIDER_TTL_MS);
      return () => window.clearTimeout(timer);
    }
  }, [channel.id, session]);

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
        const index = messages.findIndex((message) => message.id > dividerReadId);
        if (index > 0) {
          listRef.current?.scrollToKey(String(messages[index]?.id), "center");
        }
      }, 60);
    } else {
      window.setTimeout(() => listRef.current?.scrollToBottom(), 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length > 0]);

  // New messages stick to the bottom while the user is there.
  const messageCountRef = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > messageCountRef.current;
    messageCountRef.current = messages.length;
    if (grew && nearBottomRef.current) {
      listRef.current?.scrollToBottom();
    }
  }, [messages]);

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
    void session.loadOlder(channel.id, messages[0]!.id)
      .then((rawPageLength) => {
        if (rawPageLength < HISTORY_PAGE) {
          hasOlderRef.current = false; // end of history latches on the RAW page
        }
      })
      .catch(() => undefined)
      .finally(() => {
        loadingOlderRef.current = false;
      });
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
      })().catch(() => undefined);
    },
  };

  const groupStarts = useMemo(() => computeGroupStarts(messages.map((message): GroupableMessage => ({
    id: message.id,
    authorUsername: message.authorUsername,
    createdAtEpochMs: toEpochMs(message.createdAt),
  }))), [messages]);

  const dividerIndex = dividerReadId === null
    ? -1
    : messages.findIndex((message) => message.id > dividerReadId);

  return (
    <VirtualList
      className="message-list virtual-list"
      ref={listRef}
      items={messages}
      itemKey={(message) => String(message.id)}
      estimateHeight={estimateRowHeight}
      onNearTop={loadOlder}
      onBottomProximity={(nearBottom) => {
        nearBottomRef.current = nearBottom;
        if (nearBottom) {
          setDividerReadId(null); // reaching the bottom dismisses the divider
        }
      }}
      renderItem={(message, index) => (
        <>
          {index === dividerIndex ? (
            <div className="new-messages-divider"><span>NEW</span></div>
          ) : null}
          <MessageRow
            session={session}
            channel={channel}
            message={message}
            startsGroup={groupStarts[index] ?? true}
            editing={editing?.id === message.id}
            highlighted={highlightId === message.id}
            selected={actions.selectionMode && actions.selection.has(message.id)}
            actions={wiredActions}
            setEditing={props.setEditing}
            onMenu={props.onMenu}
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
  startsGroup: boolean;
  editing: boolean;
  highlighted: boolean;
  selected: boolean;
  actions: ChatActions;
  setEditing(message: Message | null): void;
  onMenu(state: { message: Message; x: number; y: number }): void;
}

function MessageRow(props: MessageRowProps): React.JSX.Element {
  const { session, channel, message, startsGroup, editing, highlighted, selected, actions } = props;
  const [draft, setDraft] = useState(message.content ?? "");

  useEffect(() => {
    setDraft(message.content ?? "");
  }, [message.id, message.content]);

  const commitEdit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === (message.content ?? "")) {
      props.setEditing(null);
      return;
    }
    void session.editMessage(channel.id, message.id, trimmed).catch(() => undefined);
    props.setEditing(null);
  };

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
      {startsGroup ? (
        <Avatar session={session} username={message.authorUsername} size={40} />
      ) : (
        <div className="message-gutter">{formatTimeOfDay(toEpochMs(message.createdAt))}</div>
      )}
      <div className="message-body">
        {startsGroup ? (
          <div className="message-meta">
            <span className="message-author">{message.authorUsername}</span>
            <span className="message-time">{formatTimeOfDay(toEpochMs(message.createdAt))}</span>
          </div>
        ) : null}
        {message.forward !== null ? <ForwardCard forward={message.forward} /> : null}
        {message.reply !== null ? <QuoteCard level={message.reply} depth={0} onJump={actions.jumpTo} /> : null}
        {editing ? (
          <textarea
            className="inline-editor"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                commitEdit();
              } else if (event.key === "Enter" && (event.ctrlKey || event.shiftKey) && !event.altKey) {
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
        ) : (
          <div className="message-content">
            {segmentMessageContent(message.content, message.mentions).map((segment, segmentIndex) =>
              segment.kind === "mention"
                ? <span key={segmentIndex} className="mention">{segment.text}</span>
                : <span key={segmentIndex}>{segment.text}</span>,
            )}
            {message.editedAt !== null ? <span className="message-edited">(edited)</span> : null}
          </div>
        )}
        <AttachmentView session={session} message={message} />
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
}

function QuoteCard({ level, depth, onJump }: { level: ReplyInfo; depth: number; onJump: (messageId: number) => void }): React.JSX.Element {
  if (level.deleted) {
    return <div className="quote-card deleted">Original message deleted</div>;
  }
  return (
    <div className="quote-card">
      <span className="quote-author" onClick={() => onJump(level.messageId)}>{level.authorUsername}</span>
      <span className="quote-preview">{level.preview}</span>
      {level.forward !== null ? <span className="quote-forward">↗ from {level.forward.authorUsername}</span> : null}
      {level.reply !== null && depth < QUOTE_DEPTH_MAX ? <QuoteCard level={level.reply} depth={depth + 1} onJump={onJump} /> : null}
    </div>
  );
}

function ForwardCard({ forward }: { forward: ForwardInfo }): React.JSX.Element {
  return (
    <div className="forward-card">
      <span className="quote-author">Forwarded from {forward.authorUsername}</span>
      <span className="quote-meta">{forward.serverName} → #{forward.channelName}{forward.trusted ? "" : " · unverified"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({ placeholder, attachEnabled, allowEmptySend, onPaste, onSend }: {
  placeholder: string;
  attachEnabled: boolean;
  allowEmptySend: boolean;
  onPaste(files: readonly File[]): void;
  onSend: (content: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (submitError) {
      // Keep the text — a failed send must never eat the draft.
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        rows={Math.min(4, Math.max(1, text.split("\n").length))}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (attachEnabled && files.length > 0) {
            event.preventDefault();
            onPaste(files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Enter" && (event.ctrlKey || event.shiftKey) && !event.altKey) {
            // The oak composer contract: Ctrl+Enter OR Shift+Enter breaks the line
            // (Ctrl+Enter needs the manual insert — Chromium treats it as non-text).
            event.preventDefault();
            const textarea = event.currentTarget;
            textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
            setText(textarea.value);
          }
        }}
      />
      <div className="composer-foot">
        <span className="composer-hint">Enter to send · Ctrl/Shift+Enter for a new line</span>
        <span className="error-line">{error ?? ""}</span>
      </div>
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
            originAuthorName: message.authorUsername,
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
