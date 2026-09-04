import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Pinned controls for the one shared audio track — visible whatever scrolls. */
export function NowPlayingBar({ session }: { session: ConnectionSession }): React.JSX.Element | null {
  const state = useStore(session.playback, (current) => current);
  if (state.key === null) {
    return null;
  }
  return (
    <div className="now-playing">
      <button className="ghost" onClick={() => {
        if (state.playing) {
          session.playback.pause();
        } else if (state.key !== null) {
          // Resume path — the service keeps the element and its position.
          void session.playback.resume();
        }
      }}>
        {state.playing ? "❚❚" : "▶"}
      </button>
      <span className="now-playing-name">{state.fileName ?? "audio"}</span>
      <input
        type="range" min={0} max={Math.max(0.1, state.durationSeconds)} step={0.1}
        value={state.positionSeconds}
        onChange={(event) => session.playback.seek(event.currentTarget.valueAsNumber)}
      />
      <span className="now-playing-time">
        {formatClock(state.positionSeconds)} / {formatClock(state.durationSeconds)}
      </span>
      <input
        className="now-playing-volume" type="range" min={0} max={1} step={0.01}
        value={state.volume}
        onChange={(event) => session.playback.setVolume(event.currentTarget.valueAsNumber)}
      />
      <button className="ghost" onClick={() => session.playback.stop()}>✕</button>
    </div>
  );
}
