import { useStore } from "../hooks/useStore";
import { appStore } from "../runtime";

/** Chat lands in M1-M2; M0 keeps the voice-first shell with an honest placeholder. */
export function ChatPane(): React.JSX.Element {
  const voiceState = useStore(appStore, (state) => state.voiceState);
  const stateDetail = useStore(appStore, (state) => state.stateDetail);
  return (
    <div className="chat-placeholder">
      <div className="login-title">chat</div>
      <div className="error-line">Arrives in M1: history, composer, live updates.</div>
      {voiceState !== "idle" && stateDetail ? <div className="error-line">{stateDetail}</div> : null}
    </div>
  );
}
