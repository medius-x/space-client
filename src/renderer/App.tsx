import { useStore } from "./hooks/useStore";
import { appStore } from "./runtime";
import { LoginScreen } from "./components/LoginScreen";
import { MainScreen } from "./components/MainScreen";

export function App(): React.JSX.Element {
  const screen = useStore(appStore, (state) => state.screen);
  return screen === "login" ? <LoginScreen /> : <MainScreen />;
}
