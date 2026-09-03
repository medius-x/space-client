import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";
import { log } from "../../logging";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Message } from "../../types";
import { computeGroupStarts, formatTimeOfDay, toEpochMs } from "../../domain/logic/message-grouping";

/**
 * The chat pane: channel header, grouped message list, composer. History loads once
 * per channel (the effect keys on activeChannelId); live messages arrive through the
 * store's /topic/channel.{id} subscription and dedup against the REST echo by id.
 */
export function ChatPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const messages = useStore(session.messageStore, (store) => store.listFor(activeChannelId ?? -1));
  const channelPermissions = useStore(session.permissionStore, (state) =>
    activeChannelId === null ? null : state.channels.get(activeChannelId) ?? null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (activeChannelId === null) {
      return;
    }
    setHistoryError(null);
    session.loadHistory(activeChannelId).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : String(error));
    });
    // Override-aware composer gate — cached per channel after the first fetch.
    session.ensureChannelPermissions(activeChannelId).catch((error: unknown) => {
      log.warn("chat", `permission check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeChannelId, session]);

  const channel = activeChannelId !== null
    ? channels.find((entry) => entry.id === activeChannelId) ?? null
    : null;

  if (channel === null) {
    return (
      <div className="chat-pane">
        <div className="chat-empty">No text channel — pick one in the sidebar or create it with +.</div>
      </div>
    );
  }

  return (
    <div className="chat-pane">
      <div className="chat-header"><span className="channel-hash">#</span> {channel.name}</div>
      {historyError !== null ? <div className="chat-error">history: {historyError}</div> : null}
      <MessageList messages={messages} />
      {channelPermissions === null ? (
        <div className="composer-gate">…</div>
      ) : channelPermissions.sendMessages ? (
        <Composer
          placeholder={`Message #${channel.name}`}
          onSend={(content) => session.sendMessage(channel.id, content)}
        />
      ) : (
        <div className="composer-gate">You do not have permission to send messages in this channel.</div>
      )}
    </div>
  );
}

function MessageList({ messages }: { messages: readonly Message[] }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Autoscroll ONLY while the user is at the bottom — reading backlog must win.
  useEffect(() => {
    const element = containerRef.current;
    if (element !== null && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const groupStarts = useMemo(
    () => computeGroupStarts(messages.map((message) => ({
      id: message.id,
      authorUsername: message.authorUsername,
      createdAtEpochMs: toEpochMs(message.createdAt),
    }))),
    [messages],
  );

  return (
    <div
      className="message-list"
      ref={containerRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {messages.map((message, index) =>
        groupStarts[index]
          ? <MessageHeadRow key={message.id} message={message} />
          : <MessageContinuationRow key={message.id} message={message} />,
      )}
    </div>
  );
}

function MessageHeadRow({ message }: { message: Message }): React.JSX.Element {
  return (
    <div className="message-row head">
      <div className="message-avatar">{(message.authorUsername.charAt(0) || "?").toUpperCase()}</div>
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{message.authorUsername}</span>
          <span className="message-time">{formatTimeOfDay(toEpochMs(message.createdAt))}</span>
        </div>
        <div className="message-content">
          {message.content}
          {message.editedAt !== null ? <span className="message-edited">(edited)</span> : null}
        </div>
        <AttachmentNote message={message} />
      </div>
    </div>
  );
}

function MessageContinuationRow({ message }: { message: Message }): React.JSX.Element {
  return (
    <div className="message-row continuation">
      <div className="message-gutter">{formatTimeOfDay(toEpochMs(message.createdAt))}</div>
      <div className="message-body">
        <div className="message-content">
          {message.content}
          {message.editedAt !== null ? <span className="message-edited">(edited)</span> : null}
        </div>
        <AttachmentNote message={message} />
      </div>
    </div>
  );
}

function AttachmentNote({ message }: { message: Message }): React.JSX.Element | null {
  if (message.attachments.length === 0) {
    return null;
  }
  return <div className="message-attachments">📎 {message.attachments.length} attachment(s) — rendered in M3</div>;
}

function Composer({ placeholder, onSend }: {
  placeholder: string;
  onSend: (content: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const content = text.trim();
    if (!content || busy) {
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
