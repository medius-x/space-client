import { useEffect } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, retryConnection, toggleUserSettings } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { ServerRail } from "./ServerRail";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { FriendsPane } from "./FriendsPane";
import { MembersPane } from "./MembersPane";
import { VoiceBar, RoomView } from "./VoiceRoom";
import { CallConflictModal, CallOverlayCard, CallPane } from "./CallPane";
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
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const roomViewOpen = useStore(appStore, (state) => state.roomViewOpen);

  // The diagnostics panel is a hidden hotkey away (Ctrl+Shift+D) — the default
  // window must look exactly like what a user gets.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.code === "KeyD") {
        event.preventDefault();
        appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The live call takes over the content area (oak's call room view); a RING does
  // not — the card overlay leaves chat usable while the phone "rings".
  const callOccupiesContent = callState === "connecting" || callState === "in-call";
  const friendsOccupiesContent = dmMode && activeDmId === null;
  // oak layout: the room view is a chat-area swap (voice bar click); the roster
  // is its own 190px column beside the chat — hidden in Home mode and under the
  // full-width call view.
  const roomViewOccupiesContent = roomViewOpen && !callOccupiesContent && !friendsOccupiesContent;
  const rosterVisible = !dmMode && !callOccupiesContent && !roomViewOccupiesContent;

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
          {callOccupiesContent ? (
            <CallPane session={session} />
          ) : friendsOccupiesContent ? (
            <FriendsPane session={session} />
          ) : roomViewOccupiesContent ? (
            <RoomView session={session} />
          ) : (
            <ChatPane session={session} />
          )}
          {rosterVisible ? <MembersPane session={session} /> : null}
        </main>
      </div>
      {/* The settings overlays live in App (direct children of #app) — see App.tsx. */}
      <CallOverlayCard />
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
  const stompState = useStore(appStore, (state) => state.stompState);
  const stompAttempt = useStore(appStore, (state) => state.stompAttempt);
  const stompCountdown = useStore(appStore, (state) => state.stompCountdown);
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
        <span className="user-bar-name">{ownUsername}</span>
        <span className="user-bar-status-row">
          <span className={"user-bar-status " + status.className}>{status.text}</span>
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
