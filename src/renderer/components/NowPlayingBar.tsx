import { useRef } from "react";
import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Pinned controls for the one shared audio track — visible whatever scrolls.
 *  oak's bar: play/pause, title, seek (disabled until the duration lands),
 *  clock, a volume slider with a 0 ↔ last-positive MUTE toggle, close. */
export function NowPlayingBar({ session }: { session: ConnectionSession }): React.JSX.Element | null {
  const state = useStore(session.playback, (current) => current);
  const lastPositiveVolumeRef = useRef(state.volume > 0 ? state.volume : 1);
  if (state.key === null) {
    return null;
  }
  const knownDuration = state.durationSeconds > 0;
  return (
    <div className="now-playing">
      <button
        className="ghost icon-button"
        title={state.playing ? "Pause" : "Play"}
        onClick={() => {
          if (state.playing) {
            session.playback.pause();
          } else if (state.key !== null) {
            // Resume path — the service keeps the element and its position.
            void session.playback.resume();
          }
        }}
      >
        <span className={"icon " + (state.playing ? "mdi-pause" : "mdi-play")} />
      </button>
      <span className="now-playing-name">{state.fileName ?? "audio"}</span>
      <input
        type="range" min={0} max={knownDuration ? state.durationSeconds : 1} step={0.1}
        value={state.positionSeconds}
        disabled={!knownDuration}
        onChange={(event) => session.playback.seek(event.currentTarget.valueAsNumber)}
      />
      <span className="now-playing-time">
        {knownDuration
          ? `${formatClock(state.positionSeconds)} / ${formatClock(state.durationSeconds)}`
          : `${formatClock(state.positionSeconds)} / --:--`}
      </span>
      <input
        className="now-playing-volume" type="range" min={0} max={1} step={0.01}
        value={state.volume}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (next > 0) {
            lastPositiveVolumeRef.current = next; // dragging up from zero unmutes too
          }
          session.playback.setVolume(next);
        }}
      />
      <button
        className="ghost icon-button"
        title={state.volume === 0 ? "Unmute" : "Mute"}
        onClick={() => session.playback.setVolume(state.volume === 0 ? lastPositiveVolumeRef.current : 0)}
      >
        <span className={"icon " + (state.volume === 0 ? "mdi-volume-off" : "mdi-volume-high")} />
      </button>
      <button className="ghost icon-button" title="Stop" onClick={() => session.playback.stop()}>
        <span className="icon mdi-close" />
      </button>
    </div>
  );
}
