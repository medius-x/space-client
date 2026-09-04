import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  getCameraTrack,
  kickVoiceUser,
  leaveVoice,
  openSharePopout,
  persistedGain,
  popoutClosed,
  roomAudio,
  sendPopoutFrame,
  serverDeafenUser,
  serverMuteUser,
  setShareVolume,
  setVoiceVolume,
  setViewingFeed,
  shareTarget,
  stopShare,
  toggleCamera,
  toggleSelfDeafen,
  toggleSelfMute,
  toggleTestTone,
  voiceView,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { VoiceMemberMarks } from "../../domain/stores/VoiceControlStore";
import type { FeedInfo } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SharePickerModal } from "./SharePickerModal";

const VOICE_STATE_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  live: "Voice connected",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
};

/** Pop-out frame pump: ~12 JPEG frames/s, capped at 1280 wide (IPC, not raw bitmaps). */
const POPOUT_FRAME_INTERVAL_MS = 80;
const POPOUT_MAX_WIDTH = 1280;

/** MOD wins over SELF when both hold (oak convention: red beats yellow). */
function markTone(modFlag: boolean, selfFlag: boolean): "none" | "self" | "mod" {
  if (modFlag) {
    return "mod";
  }
  return selfFlag ? "self" : "none";
}

/** Mute/deafen badges for a voice member — shared by the room tiles and the sidebar. */
export function VoiceMarks({ marks }: { marks: VoiceMemberMarks | undefined }): React.JSX.Element | null {
  const muteTone = markTone(marks?.modMuted ?? false, marks?.selfMuted ?? false);
  const deafenTone = markTone(marks?.modDeafened ?? false, marks?.selfDeafened ?? false);
  if (muteTone === "none" && deafenTone === "none") {
    return null;
  }
  return (
    <span className="voice-marks">
      {muteTone !== "none" ? <span className={`voice-mark voice-mark-${muteTone}`} title={muteTone === "mod" ? "Muted by a moderator" : "Muted by themselves"}>🔇</span> : null}
      {deafenTone !== "none" ? <span className={`voice-mark voice-mark-${deafenTone}`} title={deafenTone === "mod" ? "Deafened by a moderator" : "Deafened by themselves"}>🎧</span> : null}
    </span>
  );
}

/**
 * The voice room: status line, participant tiles (speaking ring + voice/share volume
 * sliders + dB meters + mute/deafen marks + moderation context menu), share viewer
 * with a pop-out, camera preview, toolbar with the self toggles. HOT PATHS ARE
 * IMPERATIVE: speaking rings and meters update via refs on the 10 Hz audio poll —
 * no React re-render per frame (a re-render would rip the range sliders out from
 * under the cursor).
 */
export function VoiceRoom({ session }: { session: ConnectionSession }): React.JSX.Element {
  const voiceState = useStore(appStore, (state) => state.voiceState);
  const stateDetail = useStore(appStore, (state) => state.stateDetail);
  const participants = useStore(appStore, (state) => state.participants);
  const sharing = useStore(appStore, (state) => state.sharing);
  const cameraOn = useStore(appStore, (state) => state.cameraOn);
  const popoutActive = useStore(appStore, (state) => state.popoutActive);
  const testToneChannel = useStore(appStore, (state) => state.testToneChannel);
  const viewingFeedId = useStore(appStore, (state) => state.viewingFeedId);
  const viewingUsername = useStore(appStore, (state) => state.viewingUsername);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? "you";
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const marksByMember = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const myPermissions = useStore(session.permissionStore, (state) => state.my?.permissions ?? []);
  const canMuteMembers = myPermissions.includes("MUTE_MEMBERS");
  const canDeafenMembers = myPermissions.includes("DEAFEN_MEMBERS");
  const canKickMembers = myPermissions.includes("MOVE_MEMBERS");

  const shareVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const meterRefs = useRef(new Map<string, { voice: HTMLElement | null; share: HTMLElement | null }>());
  const [meterTick, setMeterTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memberMenu, setMemberMenu] = useState<{ username: string; x: number; y: number } | null>(null);
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

  // The pop-out's "closed" signal — stop pumping frames.
  useEffect(() => {
    window.spaceWindow?.onClosed(() => popoutClosed());
  }, []);

  // Own camera preview binds to the live local track.
  useEffect(() => {
    const element = cameraVideoRef.current;
    if (!element) {
      return;
    }
    const track = cameraOn ? getCameraTrack() : null;
    element.srcObject = track !== null ? new MediaStream([track]) : null;
  }, [cameraOn]);

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

  // Pop-out frame pump: grabs the share <video> into a canvas → JPEG → IPC.
  useEffect(() => {
    if (!popoutActive || viewingFeedId === null) {
      return;
    }
    const video = shareVideoRef.current;
    if (!video) {
      return;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    let timer = 0;
    let cancelled = false;
    const pump = () => {
      if (cancelled) {
        return;
      }
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const scale = Math.min(1, POPOUT_MAX_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        sendPopoutFrame(canvas.toDataURL("image/jpeg", 0.75));
      }
      timer = window.setTimeout(pump, POPOUT_FRAME_INTERVAL_MS);
    };
    timer = window.setTimeout(pump, POPOUT_FRAME_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [popoutActive, viewingFeedId]);

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

  const openMemberMenu = (username: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canMuteMembers && !canDeafenMembers && !canKickMembers) {
      return; // oak parity: no permission, no popup at all
    }
    setMemberMenu({ username, x: event.clientX, y: event.clientY });
  };

  const memberMenuItems: ContextMenuItem[] = memberMenu === null ? [] : [
    ...(canMuteMembers ? [{
      label: marksByMember.get(memberMenu.username)?.modMuted ? "Unmute" : "Server mute",
      action: () => serverMuteUser(memberMenu.username),
    }] : []),
    ...(canDeafenMembers ? [{
      label: marksByMember.get(memberMenu.username)?.modDeafened ? "Undeafen" : "Server deafen",
      action: () => serverDeafenUser(memberMenu.username),
    }] : []),
    ...(canKickMembers ? [{
      label: "Kick from voice",
      danger: true,
      action: () => kickVoiceUser(memberMenu.username),
    }] : []),
  ];

  const ownMarks = marksByMember.get(session.username());
  const selfMuted = (ownMarks?.selfMuted ?? false) || (ownMarks?.modMuted ?? false);
  const selfDeafened = (ownMarks?.selfDeafened ?? false) || (ownMarks?.modDeafened ?? false);

  const renderTile = (username: string, isSelf: boolean, feed: FeedInfo | null) => (
    <div key={username} ref={setTileRef(username)} className={"tile" + (isSelf ? " self" : "")}>
      <div className="tile-head">
        <div className="tile-avatar">{(username[0] ?? "?").toUpperCase()}</div>
        <div className="tile-name">{username}</div>
        <VoiceMarks marks={marksByMember.get(username)} />
        <div className="tile-badges">{isSelf ? "you" : ""}</div>
      </div>
      {isSelf && cameraOn ? <video ref={cameraVideoRef} className="camera-preview" autoPlay playsInline muted /> : null}
      <div className="tile-controls">
        <label>voice</label>
        <input
          type="range" min={0} max={200}
          defaultValue={String(Math.round(persistedGain("voice", username) * 100))}
          onChange={(event) => setVoiceVolume(username, event.currentTarget.valueAsNumber / 100)}
        />
        <span className="level-meter" ref={setMeterRef(username, "voice")}>—</span>
      </div>
      <div className="tile-controls">
        <label>share</label>
        <input
          type="range" min={0} max={200}
          defaultValue={String(Math.round(persistedGain("share", username) * 100))}
          onChange={(event) => setShareVolume(username, event.currentTarget.valueAsNumber / 100)}
        />
        <span className="level-meter" ref={setMeterRef(username, "share")}>—</span>
      </div>
      {feed ? (
        <button className="ghost" onClick={() => setViewingFeed(feed.feedId)}>
          {viewingFeedId === feed.feedId ? "Stop watching" : "Watch screen"}
        </button>
      ) : null}
      {!isSelf ? <div className="tile-menu-hint" onContextMenu={openMemberMenu(username)}>⋯</div> : null}
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
            <span className="share-panel-actions">
              <button className="ghost" onClick={() => void openSharePopout()} disabled={popoutActive}>Pop out</button>
              <button className="ghost" onClick={() => setViewingFeed(viewingFeedId)}>Stop watching</button>
            </span>
          </div>
          <video ref={shareVideoRef} autoPlay playsInline />
        </div>
      ) : null}
      <div className="tile-grid">
        {renderTile(session.username(), true, null)}
        {participants.map((feed) => renderTile(feed.display, false, feed))}
      </div>
      <div className="room-toolbar">
        <button
          className={"voice-toggle" + (selfMuted ? " on" : "")}
          title={selfMuted ? "Unmute" : "Mute"}
          onClick={toggleSelfMute}
        >
          {selfMuted ? "🔇 Muted" : "🎤 Mute"}
        </button>
        <button
          className={"voice-toggle" + (selfDeafened ? " on" : "")}
          title={selfDeafened ? "Undeafen" : "Deafen"}
          onClick={toggleSelfDeafen}
        >
          {selfDeafened ? "🎧 Deafened" : "🎧 Deafen"}
        </button>
        <button
          className={"voice-toggle" + (cameraOn ? " on" : "")}
          onClick={() => void toggleCamera()}
        >
          {cameraOn ? "📷 Camera off" : "📷 Camera"}
        </button>
        {sharing ? (
          <button className="on" onClick={() => void stopShare()}>Stop sharing</button>
        ) : (
          <button onClick={() => setPickerOpen(true)}>Share screen…</button>
        )}
        <button className={testToneChannel === "left" ? "on" : "ghost"} onClick={() => toggleTestTone("left")}>Tone L</button>
        <button className={testToneChannel === "right" ? "on" : "ghost"} onClick={() => toggleTestTone("right")}>Tone R</button>
        <button className="danger" onClick={() => void leaveVoice()}>Leave</button>
      </div>
      {memberMenu !== null ? (
        <ContextMenu x={memberMenu.x} y={memberMenu.y} items={memberMenuItems} onClose={() => setMemberMenu(null)} />
      ) : null}
      {pickerOpen ? <SharePickerModal onClose={() => setPickerOpen(false)} onTarget={(target) => {
        setPickerOpen(false);
        void shareTarget(target);
      }} /> : null}
    </div>
  );
}
