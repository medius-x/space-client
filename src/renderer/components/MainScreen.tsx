import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { FriendsPane } from "./FriendsPane";
import { ServerSettingsPane } from "./ServerSettingsPane";
import { UserSettingsModal } from "./UserSettingsModal";
import { VoiceRoom } from "./VoiceRoom";
import { CallConflictModal, CallOverlayCard, CallPane } from "./CallPane";
import { Diagnostics } from "./Diagnostics";

export function MainScreen({ session }: { session: ConnectionSession }): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const callState = useStore(appStore, (state) => state.callState);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const serverSettingsOpen = useStore(appStore, (state) => state.serverSettingsOpen);
  const userSettingsOpen = useStore(appStore, (state) => state.userSettingsOpen);
  const toggleDiag = () => appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
  // The live call takes over the content area (oak's call room view); a RING does
  // not — the card overlay leaves chat usable while the phone "rings".
  const callOccupiesContent = callState === "connecting" || callState === "in-call";
  const settingsOccupiesContent = serverSettingsOpen && !callOccupiesContent;
  const friendsOccupiesContent = dmMode && activeDmId === null;
  return (
    <>
      <div className="main-shell">
        <Sidebar session={session} />
        <main className="content">
          {callOccupiesContent ? (
            <CallPane session={session} />
          ) : settingsOccupiesContent ? (
            <ServerSettingsPane session={session} />
          ) : friendsOccupiesContent ? (
            <FriendsPane session={session} />
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
      {userSettingsOpen ? <UserSettingsModal session={session} /> : null}
      <button className="diag-toggle" onClick={toggleDiag}>diag</button>
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}
