import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { VoiceRoom } from "./VoiceRoom";
import { Diagnostics } from "./Diagnostics";

export function MainScreen(): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const toggleDiag = () => appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
  return (
    <>
      <div className="main-shell">
        <Sidebar />
        <main className="content">
          <ChatPane />
          <VoiceRoom />
        </main>
      </div>
      <button className="diag-toggle" onClick={toggleDiag}>diag</button>
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}
