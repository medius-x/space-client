import { useEffect } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, retryConnection, toggleUserSettings } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { ConnectionQualitySnapshot } from "../../domain/logic/connection-quality";
import { ServerRail } from "./ServerRail";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { FriendsPane } from "./FriendsPane";
import { RightPane } from "./SearchPane";
import { VoiceBar, RoomView, CallConflictModal } from "./VoiceRoom";
import { useDisplayName } from "../hooks/useDisplayName";
import { Diagnostics } from "./Diagnostics";
import { Avatar } from "./Avatar";

const STOMP_STATUS: Record<string, { text: string; className: string }> = {
  off: { text: "Offline", className: "off" },
  connecting: { text: "Connecting…", className: "connecting" },
  connected: { text: "Connected", className: "connected" },
  lost: { text: "Connection lost", className: "lost" },
};

export function MainScreen({ session }: { session: ConnectionSession }): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const callState = useStore(appStore, (state) => state.callState);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const roomViewOpen = useStore(appStore, (state) => state.roomViewOpen);
  const searchOpen = useStore(appStore, (state) => state.searchOpen);

  // The diagnostics panel is a hidden hotkey away. It USED to live on
  // Ctrl+Shift+D — 2026-09-18 the chord moved to F12: Discord's Toggle Deafen
  // default claimed Ctrl+Shift+D, and a global chord would have opened the
  // panel on every focused deafen toggle.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.code === "F12") {
        event.preventDefault();
        appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A 1:1 call does NOT take the chat pane (oak): its surfaces are the voice
  // bar + the room view (a degenerate 2-tile room). The room view is a
  // chat-area swap opened by the voice-bar click (auto-opened on accept).
  // The right column (search box header + roster/results body) is a SERVER-mode
  // fixture: hidden in Home (the DM chat keeps its full width) — except while
  // a DM search is open, when the column appears to host it.
  const friendsOccupiesContent = dmMode && activeDmId === null;
  const voiceSurfaceLive = callState !== "idle" || activeVoiceChannelId !== null;
  const roomViewOccupiesContent = roomViewOpen && voiceSurfaceLive && !friendsOccupiesContent;
  const rightPaneVisible = searchOpen
    ? !friendsOccupiesContent && !roomViewOccupiesContent
    : !dmMode && !roomViewOccupiesContent;

  return (
    <>
      <div className="main-shell">
        {/* oak's left-section: the two columns with the voice+user overlay card
            floating over their bottom (margins 8 — it spans rail + channels). */}
        <div className="left-section">
          <div className="left-columns">
            <ServerRail activeRecordId={session.recordId} session={session} />
            <Sidebar session={session} />
          </div>
          <div className="left-overlay">
            <VoiceBar session={session} />
            <UserBar session={session} />
          </div>
        </div>
        <main className="content">
          {friendsOccupiesContent ? (
            <FriendsPane session={session} />
          ) : roomViewOccupiesContent ? (
            <RoomView session={session} />
          ) : (
            <ChatPane session={session} />
          )}
          {rightPaneVisible ? <RightPane session={session} /> : null}
        </main>
      </div>
      {/* The settings overlays live in App (direct children of #app) — see App.tsx. */}
      <CallConflictModal />
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}

/** The lower half of the overlay card: avatar + nick + connection status (+ the
 *  ↻ retry while the connection is down) and the ONE chrome button (settings) —
 *  avatar editing lives in Settings (oak parity). */
function UserBar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  // The rename model: the bar shows the NICKNAME; the login never renders.
  const ownDisplayName = useDisplayName(session, ownUsername);
  const stompState = useStore(appStore, (state) => state.stompState);
  const stompAttempt = useStore(appStore, (state) => state.stompAttempt);
  const stompCountdown = useStore(appStore, (state) => state.stompCountdown);
  const connectionQuality = useStore(appStore, (state) => state.connectionQuality);
  const voiceConnected = useStore(appStore, (state) => state.activeVoiceChannelId !== null);
  const base = STOMP_STATUS[stompState] ?? STOMP_STATUS.off!;
  // oak's label exactly: "Reconnecting in Ns… M/10" while the attempt is
  // scheduled (the per-second countdown), "Reconnecting… M/10" while it flies.
  const status = stompState === "connecting" && stompAttempt > 0
    ? {
      text: stompCountdown !== null
        ? `Reconnecting in ${stompCountdown}s… ${stompAttempt}/10`
        : `Reconnecting… ${stompAttempt}/10`,
      className: "connecting",
    }
    : base;
  const retryable = stompState === "lost" || stompState === "connecting";
  return (
    <div className={"user-bar" + (voiceConnected ? " with-voice" : "")}>
      <Avatar session={session} username={ownUsername} size={32} />
      <div className="user-bar-text">
        <span className="user-bar-name">{ownDisplayName}</span>
        <span className="user-bar-status-row">
          <span className={"user-bar-status " + status.className}>{status.text}</span>
          {/* The ping indicator rides ALONGSIDE the status while connected —
              while down, the status row itself already tells the story. */}
          {stompState === "connected" ? <PingBadge quality={connectionQuality} /> : null}
          {/* oak's retryButton: visible only while the connection is down; the
              slot stays reserved so the row never jumps when it appears. */}
          {retryable ? (
            <button
              className={"user-bar-retry " + status.className}
              title="Reconnect now"
              onClick={retryConnection}
            >
              <span className="icon mdi-refresh" />
            </button>
          ) : <span className="user-bar-retry-slot" />}
        </span>
      </div>
      <button className="ghost user-bar-button" title="Settings" onClick={toggleUserSettings}>
        <span className="icon mdi-cog" />
      </button>
    </div>
  );
}

/** The connection-quality dot + ms (RTT of the STOMP socket, Discord-style).
 *  "unsupported" = this server build predates the /app/ping echo — the REST
 *  request latency keeps the number alive; "probing" = the first ping flies. */
function PingBadge({ quality }: { quality: ConnectionQualitySnapshot }): React.JSX.Element {
  const millis = quality.state === "unsupported" ? quality.lastRestMillis : quality.lastRttMillis;
  const text = quality.state === "probing" || millis === null
    ? quality.state === "unsupported" ? "—" : "…"
    : `${millis} ms`;
  return (
    <span className={"ping-badge " + quality.state} title={pingBadgeTitle(quality)}>
      <span className="ping-dot" />
      <span className="ping-text">{text}</span>
    </span>
  );
}

function pingBadgeTitle(quality: ConnectionQualitySnapshot): string {
  if (quality.state === "probing") {
    return "Measuring connection quality…";
  }
  if (quality.state === "unsupported") {
    return quality.lastRestMillis === null
      ? "Ping is not supported by this server build"
      : `Ping is not supported by this server build — showing request latency (${quality.lastRestMillis} ms)`;
  }
  const verdict = quality.state === "good" ? "Stable" : quality.state === "weak" ? "Unstable" : "Poor";
  const window = quality.windowAvgMillis === null
    ? ""
    : ` · avg ${Math.round(quality.windowAvgMillis)} / min ${quality.windowMinMillis} / max ${quality.windowMaxMillis} ms (last 60 s)`;
  const jitter = quality.jitterMillis === null ? "" : ` · jitter ${Math.round(quality.jitterMillis)} ms`;
  const misses = quality.consecutiveMisses > 0
    ? ` · ${quality.consecutiveMisses} lost ping${quality.consecutiveMisses > 1 ? "s" : ""}`
    : "";
  return `${verdict} connection — ${quality.lastRttMillis} ms now${window}${jitter}${misses}`;
}
