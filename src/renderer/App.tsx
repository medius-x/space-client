import { useEffect, useState } from "react";
import { useStore } from "./hooks/useStore";
import { appStore, closeServerSettings, connectionDirectory, sessionBinding, toggleUserSettings } from "./runtime";
import type { ConnectionSession } from "../domain/session/connection-session";
import { CaptionBar } from "./components/CaptionBar";
import { LoginModal } from "./components/LoginModal";
import { MainScreen } from "./components/MainScreen";
import { ServerRail } from "./components/ServerRail";
import { ServerSettingsPane } from "./components/ServerSettingsPane";
import { UserSettingsModal } from "./components/UserSettingsModal";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App(): React.JSX.Element {
  const session = useStore(sessionBinding, (current) => current);
  const loginFormOpen = useStore(appStore, (state) => state.loginFormOpen);
  const serverSettingsOpen = useStore(appStore, (state) => state.serverSettingsOpen);
  const userSettingsOpen = useStore(appStore, (state) => state.userSettingsOpen);
  // The user-settings overlay must NOT unmount through a session restart (the
  // username rename quietly reopens the session while Settings is open — oak
  // keeps the window): during the gap the binding drops to null, and the
  // overlay keeps rendering against the previous session object.
  const [lastSession, setLastSession] = useState<ConnectionSession | null>(null);
  useEffect(() => {
    if (session !== null) {
      setLastSession(session);
    }
  }, [session]);
  const settingsSession = session ?? lastSession;
  return (
    <ErrorBoundary>
      {/* The oak server-icon squircle in objectBoundingBox units — ONE clip for
          every size (rail 48px, the settings preview). OUT OF FLOW: an inline
          0×0 svg still opens a line box and pushed the whole app down (the
          composer/user bar slid off-screen, live report). */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <clipPath id="sp-squircle" clipPathUnits="objectBoundingBox">
            <path d="M1,0.5 C1,0.1667 0.8333,0 0.5,0 C0.1667,0 0,0.1667 0,0.5 C0,0.8333 0.1667,1 0.5,1 C0.8333,1 1,0.8333 1,0.5 Z" />
          </clipPath>
        </defs>
      </svg>
      <div id="app">
        <CaptionBar />
        <div className="app-frame">
          {/* The main window is ALWAYS mounted — with no live session it shows
              the rail and an empty content area (oak parity); login is a modal. */}
          {session !== null ? <MainScreen session={session} /> : <EmptyMainScreen />}
          {loginFormOpen ? <LoginModal /> : null}
        </div>
        {/* Settings overlays are DIRECT children of #app: they cover the whole
            window below the caption, nothing in between can constrain them.
            The close ✕ lives on its OWN narrow right panel (same surface color
            — an invisible seam): the content pane's scrollbar stops LEFT of it
            and can never run under the button (oak chrome). */}
        {session !== null && serverSettingsOpen ? (
          <div className="settings-overlay">
            <ServerSettingsPane session={session} />
            <div className="settings-close-column">
              <button className="settings-overlay-close" title="Close (Esc)" onClick={closeServerSettings}>
                <span className="icon mdi-close" />
              </button>
            </div>
          </div>
        ) : null}
        {userSettingsOpen && settingsSession !== null ? (
          <div className="settings-overlay">
            <UserSettingsModal session={settingsSession} />
            <div className="settings-close-column">
              <button className="settings-overlay-close" title="Close (Esc)" onClick={toggleUserSettings}>
                <span className="icon mdi-close" />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ErrorBoundary>
  );
}

/** No live session (fresh install / the active server was removed): the rail —
 *  its "+" opens the login modal — plus an empty content area. The one other
 *  no-session state is the BOOT RESUME LADDER: a network-dead server at
 *  startup keeps "connecting" alive with no session, and the empty screen then
 *  says the server is being reached instead of inviting the user to add one. */
function EmptyMainScreen(): React.JSX.Element {
  const records = useStore(connectionDirectory, (allRecords) => allRecords);
  const stompState = useStore(appStore, (state) => state.stompState);
  const bootConnecting = stompState === "connecting";
  const target = records[0];
  return (
    <div className="main-shell">
      <div className="left-section">
        <div className="left-columns">
          <ServerRail activeRecordId={null} session={null} />
          <aside className="sidebar" />
        </div>
      </div>
      <main className="content">
        <div className="chat-empty">
          {bootConnecting
            ? `Connecting to ${target?.cachedServerName ?? target?.hostUrl ?? "the server"}…`
            : "No server connected — add one with the + on the rail."}
        </div>
      </main>
    </div>
  );
}
