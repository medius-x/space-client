import { useStore } from "./hooks/useStore";
import { appStore, sessionBinding } from "./runtime";
import { CaptionBar } from "./components/CaptionBar";
import { LoginModal } from "./components/LoginModal";
import { MainScreen } from "./components/MainScreen";
import { ServerRail } from "./components/ServerRail";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App(): React.JSX.Element {
  const session = useStore(sessionBinding, (current) => current);
  const loginFormOpen = useStore(appStore, (state) => state.loginFormOpen);
  return (
    <ErrorBoundary>
      <div id="app">
        <CaptionBar />
        <div className="app-frame">
          {/* The main window is ALWAYS mounted — with no live session it shows
              the rail and an empty content area (oak parity); login is a modal. */}
          {session !== null ? <MainScreen session={session} /> : <EmptyMainScreen />}
          {loginFormOpen ? <LoginModal /> : null}
        </div>
      </div>
    </ErrorBoundary>
  );
}

/** No live session (fresh install / the active server was removed): the rail —
 *  its "+" opens the login modal — plus an empty content area. */
function EmptyMainScreen(): React.JSX.Element {
  return (
    <div className="main-shell">
      <div className="left-section">
        <div className="left-columns">
          <ServerRail activeRecordId={null} session={null} />
          <aside className="sidebar" />
        </div>
      </div>
      <main className="content">
        <div className="chat-empty">No server connected — add one with the + on the rail.</div>
      </main>
    </div>
  );
}
