import { useStore } from "./hooks/useStore";
import { appStore, sessionBinding } from "./runtime";
import { CaptionBar } from "./components/CaptionBar";
import { LoginScreen } from "./components/LoginScreen";
import { MainScreen } from "./components/MainScreen";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App(): React.JSX.Element {
  const screen = useStore(appStore, (state) => state.screen);
  const session = useStore(sessionBinding, (current) => current);
  const main = screen === "main" && session !== null;
  return (
    <ErrorBoundary>
      <div id="app">
        <CaptionBar />
        <div className="app-frame">
          {main && session ? <MainScreen session={session} /> : <LoginScreen />}
        </div>
      </div>
    </ErrorBoundary>
  );
}
