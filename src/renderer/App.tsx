import { useStore } from "./hooks/useStore";
import { appStore, sessionBinding } from "./runtime";
import { LoginScreen } from "./components/LoginScreen";
import { MainScreen } from "./components/MainScreen";
import { ServerRail } from "./components/ServerRail";

export function App(): React.JSX.Element {
  const screen = useStore(appStore, (state) => state.screen);
  const session = useStore(sessionBinding, (current) => current);
  const main = screen === "main" && session !== null;
  return (
    <div className="app-frame">
      <ServerRail activeRecordId={session?.recordId ?? null} />
      <div className="app-body">
        {main && session ? <MainScreen session={session} /> : <LoginScreen />}
      </div>
    </div>
  );
}
