import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { VoiceRoom } from "./VoiceRoom";
import { CallConflictModal, CallOverlayCard, CallPane } from "./CallPane";
import { Diagnostics } from "./Diagnostics";

export function MainScreen({ session }: { session: ConnectionSession }): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const callState = useStore(appStore, (state) => state.callState);
  const toggleDiag = () => appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
  // The live call takes over the content area (oak's call room view); a RING does
  // not — the card overlay leaves chat usable while the phone "rings".
  const callOccupiesContent = callState === "connecting" || callState === "in-call";
  return (
    <>
      <div className="main-shell">
        <Sidebar session={session} />
        <main className="content">
          {callOccupiesContent ? (
            <CallPane session={session} />
          ) : (
            <>
              <ChatPane session={session} />
              <VoiceRoom session={session} />
            </>
          )}
        </main>
      </div>
      <CallOverlayCard />
      <CallConflictModal />
      <button className="diag-toggle" onClick={toggleDiag}>diag</button>
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}
