import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { VoiceRoom } from "./VoiceRoom";
import { Diagnostics } from "./Diagnostics";

export function MainScreen({ session }: { session: ConnectionSession }): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const toggleDiag = () => appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
  return (
    <>
      <div className="main-shell">
        <Sidebar session={session} />
        <main className="content">
          <ChatPane session={session} />
          <VoiceRoom session={session} />
        </main>
      </div>
      <button className="diag-toggle" onClick={toggleDiag}>diag</button>
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}
