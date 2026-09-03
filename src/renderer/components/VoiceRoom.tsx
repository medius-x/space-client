import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  joinVoice,
  leaveVoice,
  roomAudio,
  setShareVolume,
  setVoiceVolume,
  setViewingFeed,
  toggleShare,
  toggleTestTone,
  voiceView,
} from "../runtime";
import type { FeedInfo } from "../../types";

const VOICE_STATE_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  live: "Voice connected",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
};

/**
 * The voice room: status line, participant tiles (speaking ring + voice/share volume
 * sliders + dB meters), share viewer, toolbar. HOT PATHS ARE IMPERATIVE: speaking
 * rings and meters update via refs on the 10 Hz audio poll — no React re-render per
 * frame (a re-render would rip the range sliders out from under the cursor).
 */
export function VoiceRoom(): React.JSX.Element {
  const voiceState = useStore(appStore, (state) => state.voiceState);
  const stateDetail = useStore(appStore, (state) => state.stateDetail);
  const participants = useStore(appStore, (state) => state.participants);
  const sharing = useStore(appStore, (state) => state.sharing);
  const testToneChannel = useStore(appStore, (state) => state.testToneChannel);
  const viewingFeedId = useStore(appStore, (state) => state.viewingFeedId);
  const viewingUsername = useStore(appStore, (state) => state.viewingUsername);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? "you";
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);

  const shareVideoRef = useRef<HTMLVideoElement | null>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const meterRefs = useRef(new Map<string, { voice: HTMLElement | null; share: HTMLElement | null }>());
  const [meterTick, setMeterTick] = useState(0);
  void meterTick; // meter text is written imperatively; state only forces the initial mount

  // Wire the runtime's imperative view hooks (outside React by design).
  useEffect(() => {
    voiceView.attachShareVideo = (username: string, track: MediaStreamTrack) => {
      const element = shareVideoRef.current;
      if (element) {
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
        void username;
      }
    };
    voiceView.dropShareVideo = () => {
      const element = shareVideoRef.current;
      if (element) {
        element.srcObject = null;
      }
    };
    voiceView.onSpeaking = (username: string, speaking: boolean) => {
      tileRefs.current.get(username)?.classList.toggle("speaking", speaking);
    };
    return () => {
      voiceView.attachShareVideo = () => undefined;
      voiceView.dropShareVideo = () => undefined;
      voiceView.onSpeaking = () => undefined;
    };
  }, []);

  // 10 Hz meter refresh — imperative DOM writes, no re-render.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [username, refs] of meterRefs.current) {
        const voiceDbfs = roomAudio.getVoiceLevelDbfs(username);
        if (refs.voice) {
          refs.voice.textContent = voiceDbfs === null ? "—" : (voiceDbfs <= -100 ? "−∞" : voiceDbfs.toFixed(0)) + " dB";
        }
        const shareDbfs = roomAudio.getShareLevelDbfs(username);
        if (refs.share) {
          refs.share.textContent = shareDbfs === null ? "—" : (shareDbfs <= -100 ? "−∞" : shareDbfs.toFixed(0)) + " dB";
        }
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  const setTileRef = (username: string) => (element: HTMLDivElement | null) => {
    if (element) {
      tileRefs.current.set(username, element);
    } else {
      tileRefs.current.delete(username);
    }
  };
  const setMeterRef = (username: string, kind: "voice" | "share") => (element: HTMLElement | null) => {
    const entry = meterRefs.current.get(username) ?? { voice: null, share: null };
    entry[kind] = element;
    meterRefs.current.set(username, entry);
  };

  const renderTile = (username: string, isSelf: boolean, feed: FeedInfo | null) => (
    <div key={username} ref={setTileRef(username)} className={"tile" + (isSelf ? " self" : "")}>
      <div className="tile-head">
        <div className="tile-avatar">{(username[0] ?? "?").toUpperCase()}</div>
        <div className="tile-name">{username}</div>
        <div className="tile-badges">{isSelf ? "you" : ""}</div>
      </div>
      <div className="tile-controls">
        <label>voice</label>
        <input
          type="range" min={0} max={200}
          defaultValue={localStorage.getItem(`space.vol.voice.${username}`) ?? "100"}
          onChange={(event) => setVoiceVolume(username, event.currentTarget.valueAsNumber / 100)}
        />
        <span className="level-meter" ref={setMeterRef(username, "voice")}>—</span>
      </div>
      <div className="tile-controls">
        <label>share</label>
        <input
          type="range" min={0} max={200}
          defaultValue={localStorage.getItem(`space.vol.share.${username}`) ?? "100"}
          onChange={(event) => setShareVolume(username, event.currentTarget.valueAsNumber / 100)}
        />
        <span className="level-meter" ref={setMeterRef(username, "share")}>—</span>
      </div>
      {feed ? (
        <button className="ghost" onClick={() => setViewingFeed(feed.feedId)}>
          {viewingFeedId === feed.feedId ? "Stop watching" : "Watch screen"}
        </button>
      ) : null}
    </div>
  );

  if (activeChannelId === null && voiceState === "idle") {
    return <div className="voice-status">Click a voice channel to connect</div>;
  }

  return (
    <div className="voice-room">
      <div className={"voice-status " + voiceState}>
        {VOICE_STATE_LABEL[voiceState] ?? voiceState}{stateDetail ? ` — ${stateDetail}` : ""}
      </div>
      {viewingFeedId !== null ? (
        <div className="share-panel">
          <div className="share-panel-head">
            <span>📺 {viewingUsername ?? "…"}'s screen</span>
            <button className="ghost" onClick={() => setViewingFeed(viewingFeedId)}>Stop watching</button>
          </div>
          <video ref={shareVideoRef} autoPlay playsInline />
        </div>
      ) : null}
      <div className="tile-grid">
        {renderTile(ownUsername, true, null)}
        {participants.map((feed) => renderTile(feed.display, false, feed))}
      </div>
      <div className="room-toolbar">
        <button className={sharing ? "on" : ""} onClick={() => void toggleShare()}>
          {sharing ? "Stop sharing" : "Share screen"}
        </button>
        <button className={testToneChannel === "left" ? "on" : "ghost"} onClick={() => toggleTestTone("left")}>Tone L</button>
        <button className={testToneChannel === "right" ? "on" : "ghost"} onClick={() => toggleTestTone("right")}>Tone R</button>
        <button className="danger" onClick={() => void leaveVoice()}>Leave</button>
      </div>
    </div>
  );
}

/** Re-join button for the failed/reconnecting states (the ladder itself lands in M4). */
export function VoiceRejoinBar(): React.JSX.Element | null {
  const voiceState = useStore(appStore, (state) => state.voiceState);
  const channels = useStore(appStore, (state) => state.channels);
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  if (voiceState !== "failed" && voiceState !== "reconnecting") {
    return null;
  }
  const channel = channels.find((entry) => entry.id === activeChannelId);
  if (!channel) {
    return null;
  }
  return (
    <button className="primary" onClick={() => void joinVoice(channel)}>Rejoin</button>
  );
}
