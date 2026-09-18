import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, openChannelAtMessage, setSearchScope } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { displayNameOf } from "../../domain/logic/display-name";
import { formatHeaderStamp, toEpochMs } from "../../domain/logic/message-grouping";
import { flattenForSearch, groupSearchResultsByDay, highlightSegments } from "../../domain/logic/search-results";
import type { Message } from "../../types";
import { Avatar } from "./Avatar";
import { MembersPane } from "./MembersPane";

/** The search page size (the server clamps to 25..50). */
const SEARCH_LIMIT = 25;
/** Debounce for the as-you-type search; Enter skips the wait. */
const SEARCH_DEBOUNCE_MS = 300;
/** Below this the query is not sent (pg_trgm needs ~3 chars to use the index; the
 *  client keeps one char of headroom for the "feels instant" threshold). */
export const MIN_QUERY_CHARS = 2;

/**
 * The right column's persistent shell (#481 polish): the header strip carrying the
 * search box (the divider line continues the chat header's, at the same 37px), and
 * the body that swaps between the roster and the search results panel. The query
 * lives HERE — it survives closing the results panel (the loupe / Escape) and
 * re-opens with the text still in the box. Typing enough characters opens the
 * panel on its own.
 */
export function RightPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const searchOpen = useStore(appStore, (state) => state.searchOpen);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Ctrl+F / the loupe open the panel — land the caret in the box.
  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    }
  }, [searchOpen]);

  const onQueryChange = (next: string) => {
    setQuery(next);
    if (next.trim().length >= MIN_QUERY_CHARS && !appStore.getSnapshot().searchOpen) {
      appStore.patch({ searchOpen: true }); // typing enough characters opens the panel
    }
  };

  return (
    <div className="right-pane">
      <div className="right-pane-header">
        <div className="right-pane-search">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search"
            title="Search messages (Ctrl+F)"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery(""); // Escape both leaves the search mode AND clears the box
                if (appStore.getSnapshot().searchOpen) {
                  appStore.patch({ searchOpen: false });
                }
              }
            }}
          />
          {query.length > 0 ? (
            <button
              className="search-clear"
              title="Clear and back to the roster (Esc)"
              onClick={() => {
                setQuery("");
                if (appStore.getSnapshot().searchOpen) {
                  appStore.patch({ searchOpen: false });
                }
              }}
            >
              <span className="icon mdi-close" />
            </button>
          ) : null}
          <button
            className="search-loupe"
            title="Search"
            onClick={() => {
              if (!searchOpen) {
                appStore.patch({ searchOpen: true });
                inputRef.current?.focus();
              }
            }}
          >
            <span className="icon mdi-magnify" />
          </button>
        </div>
      </div>
      <div className="right-pane-body">
        {searchOpen
          ? <SearchPane session={session} query={query} onQueryChange={onQueryChange} />
          : <MembersPane session={session} />}
      </div>
    </div>
  );
}

/**
 * The message-search results panel — the right column's body while search is open.
 * Scope: the open channel (or DM) vs the whole server (server channels only — the
 * wire never returns DMs there). Filters: the text query (owned by the column's
 * search box — passed in as props) + `from:` (an author chip resolved from the
 * roster BY NICKNAME — the wire carries the username). Results are newest-first,
 * grouped by day, with the hit substrings <mark>-ed; a click opens the channel ON
 * the message (the around window). The panel stays open across clicks (Discord
 * behavior); Escape in the column's search box closes it.
 */
export function SearchPane({ session, query, onQueryChange }: {
  session: ConnectionSession;
  query: string;
  onQueryChange(next: string): void;
}): React.JSX.Element {
  const users = useStore(session.rosterStore, (state) => state.users);
  const channels = useStore(session.channelStore, (state) => state);
  const searchScope = useStore(appStore, (state) => state.searchScope);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeChannelId = useStore(appStore, (state) => state.activeChannelId);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);

  // In Home the panel only ever covers the open DM — "Everywhere" is a server notion.
  const effectiveScope: "channel" | "server" = dmMode ? "channel" : searchScope;
  const scopeChannelId = dmMode ? activeDmId : activeChannelId;
  const scopeChannelName = scopeChannelId !== null ? channels.find((entry) => entry.id === scopeChannelId)?.name ?? null : null;

  const [authorFilter, setAuthorFilter] = useState<{ username: string; displayName: string } | null>(null);
  const [authorInput, setAuthorInput] = useState("");
  const [authorFocused, setAuthorFocused] = useState(false);
  const [authorIndex, setAuthorIndex] = useState(0);
  const [results, setResults] = useState<readonly Message[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [searchedAtMs, setSearchedAtMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const trimmedQuery = query.trim();
  const hasEnoughInput = trimmedQuery.length >= MIN_QUERY_CHARS || authorFilter !== null;

  const authorCandidates = useMemo(() => {
    // An EMPTY prefix matches everyone — the popup shows the whole roster the
    // moment the field is focused, exactly like the composer's @-popup (user
    // decision); typing narrows it by nick/login prefix.
    const prefix = authorInput.trim().toLowerCase();
    return users
      .filter((user) => user.displayName.toLowerCase().startsWith(prefix) || user.username.toLowerCase().startsWith(prefix))
      .slice(0, 10);
  }, [authorInput, users]);

  const runSearch = useCallback(async (beforeId?: number): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    if (beforeId === undefined) {
      setSearchedAtMs(Date.now());
    }
    try {
      const response = await session.rest.searchMessages({
        q: trimmedQuery.length > 0 ? trimmedQuery : null,
        channelId: effectiveScope === "channel" ? scopeChannelId : null,
        author: authorFilter?.username ?? null,
        beforeId,
        limit: SEARCH_LIMIT,
      });
      if (seqRef.current !== seq || session.isDisposed()) {
        return; // a newer search already answered — drop the stale page
      }
      setTotal(response.total);
      setResults((previous) => (beforeId === undefined ? response.results : [...previous, ...response.results]));
      setSearched(true);
    } catch (searchError) {
      if (seqRef.current === seq) {
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      }
    } finally {
      if (seqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [authorFilter, effectiveScope, scopeChannelId, session, trimmedQuery]);

  // As-you-type search (debounced). Empty/short input resets to the blank state.
  useEffect(() => {
    if (!hasEnoughInput) {
      seqRef.current += 1; // cancel any in-flight page
      setResults([]);
      setTotal(0);
      setSearched(false);
      setError(null);
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [hasEnoughInput, runSearch]);

  const pickAuthor = (username: string, displayName: string) => {
    setAuthorFilter({ username, displayName });
    setAuthorInput(displayName);
    setAuthorFocused(false);
  };

  const groups = useMemo(() => groupSearchResultsByDay(results, searchedAtMs), [results, searchedAtMs]);
  const canLoadMore = searched && results.length < total;

  return (
    <aside className="search-pane">
      <div className="search-filters">
        <div className="search-scope-wrap">
          <select
            className="search-scope"
            value={effectiveScope}
            disabled={dmMode}
            title={dmMode ? "A DM search covers this conversation only" : undefined}
            onChange={(event) => setSearchScope(event.target.value === "server" ? "server" : "channel")}
          >
            <option value="channel">{dmMode ? "This DM" : scopeChannelName !== null ? `#${scopeChannelName}` : "This channel"}</option>
            {!dmMode ? <option value="server">Everywhere</option> : null}
          </select>
          {/* Custom arrow: the native one hugs the box's edge regardless of padding
              (Chromium), so the select goes appearance:none and the glyph is placed
              on the loupe button's vertical. */}
          <span className="icon mdi-chevron-down search-scope-arrow" />
        </div>
        <div className="search-author">
          <input
            value={authorInput}
            placeholder="from:"
            onChange={(event) => {
              setAuthorInput(event.target.value);
              setAuthorFilter(null); // typing invalidates the picked chip
              setAuthorIndex(0);
            }}
            onFocus={() => setAuthorFocused(true)}
            onBlur={() => setAuthorFocused(false)}
            onKeyDown={(event) => {
              if (authorCandidates.length === 0) {
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setAuthorIndex((previous) => (previous + 1) % authorCandidates.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setAuthorIndex((previous) => (previous - 1 + authorCandidates.length) % authorCandidates.length);
              } else if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const candidate = authorCandidates[authorIndex];
                if (candidate !== undefined) {
                  pickAuthor(candidate.username, candidate.displayName);
                }
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setAuthorFocused(false);
              }
            }}
          />
          {authorFilter !== null ? (
            <button
              className="search-author-clear"
              title="Clear the author filter"
              onMouseDown={(event) => event.preventDefault()} // keep the field's focus
              onClick={() => {
                setAuthorFilter(null);
                setAuthorInput("");
              }}
            >×</button>
          ) : null}
          {authorFocused && authorCandidates.length > 0 ? (
            <div className="username-suggest search-author-suggest">
              {authorCandidates.map((candidate, candidateIndex) => (
                <div
                  key={candidate.username}
                  className={"mention-row" + (candidateIndex === authorIndex ? " chosen" : "")}
                  onMouseDown={(event) => event.preventDefault()} // click BEFORE blur
                  onClick={() => pickAuthor(candidate.username, candidate.displayName)}
                >
                  <Avatar session={session} username={candidate.username} size={20} />
                  <span>{candidate.displayName}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {error !== null ? <div className="search-error">{error}</div> : null}
      {searched && !loading && error === null ? (
        <div className="search-total">{total === 0 ? "No results" : `${total} result${total === 1 ? "" : "s"}`}</div>
      ) : null}
      <div className="search-results">
        {groups.map((group) => (
          <div key={group.label} className="search-day">
            <div className="search-day-header">{group.label}</div>
            {group.items.map((message) => (
              <SearchResultCard
                key={message.id}
                session={session}
                message={message}
                query={trimmedQuery.length >= MIN_QUERY_CHARS ? trimmedQuery : null}
                showChannel={effectiveScope === "server"}
                channels={channels}
              />
            ))}
          </div>
        ))}
        {canLoadMore ? (
          <button className="search-load-more" disabled={loading} onClick={() => void runSearch(results[results.length - 1]?.id)}>
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function SearchResultCard({ session, message, query, showChannel, channels }: {
  session: ConnectionSession;
  message: Message;
  query: string | null;
  showChannel: boolean;
  channels: readonly { id: number; name: string }[];
}): React.JSX.Element {
  const users = useStore(session.rosterStore, (state) => state.users);
  const authorName = displayNameOf(users, message.authorUsername);
  const preview = flattenForSearch(message.content);
  const segments = highlightSegments(preview, query);
  const channelName = showChannel ? channels.find((entry) => entry.id === message.channelId)?.name ?? null : null;
  return (
    <button className="search-hit" onClick={() => openChannelAtMessage(message.channelId, message.id)}>
      {channelName !== null ? (
        <div className="search-hit-channel"><span className="icon mdi-pound" />{channelName}</div>
      ) : null}
      <div className="search-hit-row">
        <Avatar session={session} username={message.authorUsername} size={32} />
        <div className="search-hit-body">
          <div className="search-hit-meta">
            <span className="search-hit-author">{authorName}</span>
            <span className="search-hit-time">{formatHeaderStamp(toEpochMs(message.createdAt), Date.now())}</span>
          </div>
          {segments.map((segment, segmentIndex) =>
            segment.hit ? <mark key={segmentIndex}>{segment.text}</mark> : <span key={segmentIndex}>{segment.text}</span>)}
          {message.attachments.length > 0 ? (
            <div className="search-hit-files">{message.attachments.map((attachment) => attachment.fileName).join(", ")}</div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
