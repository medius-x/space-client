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
  settingsStore,
  shareTarget,
  stopShare,
  toggleCamera,
  toggleRoomView,
  toggleSelfDeafen,
  toggleSelfMute,
  voiceView,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { VoiceMemberMarks } from "../../domain/stores/VoiceControlStore";
import type { FeedInfo } from "../../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SharePickerModal } from "./SharePickerModal";
import { HeadphonesOffIcon, TriangleWaveIcon } from "./MdiSvg";

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
      {muteTone !== "none" ? (
        <span className={`voice-mark voice-mark-${muteTone}`} title={muteTone === "mod" ? "Muted by a moderator" : "Muted by themselves"}>
          <span className="icon mdi-microphone-off" style={{ fontSize: 11 }} />
        </span>
      ) : null}
      {deafenTone !== "none" ? (
        <span className={`voice-mark voice-mark-${deafenTone}`} title={deafenTone === "mod" ? "Deafened by a moderator" : "Deafened by themselves"}>
          <HeadphonesOffIcon size={11} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * THE voice bar — the upper half of the bottom-left overlay card (oak parity):
 * the voice connection lives in the LEFT COLUMN over the rail+channels, it never
 * occupies the chat. Clicking the status row toggles the room view (the tiles)
 * in the chat area. Buttons are oak's 30×30 icon toggles: mute, deafen,
 * noise suppression (Chromium APM), share, leave.
 */
export function VoiceBar({ session }: { session: ConnectionSession }): React.JSX.Element | null {
  const voiceState = useStore(appStore, (state) => state.voiceState);
  const stateDetail = useStore(appStore, (state) => state.stateDetail);
  const sharing = useStore(appStore, (state) => state.sharing);
  const cameraOn = useStore(appStore, (state) => state.cameraOn);
  const roomViewOpen = useStore(appStore, (state) => state.roomViewOpen);
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const apmEnabled = useStore(settingsStore, (settings) => settings.apmEnabled);
  const channel = activeChannelId !== null ? session.channelStore.get(activeChannelId) : null;
  const marksByMember = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (activeChannelId === null) {
    return null; // no voice session — the card shrinks to the user bar alone
  }

  const ownMarks = marksByMember.get(session.username());
  const selfMuted = (ownMarks?.selfMuted ?? false) || (ownMarks?.modMuted ?? false);
  const selfDeafened = (ownMarks?.selfDeafened ?? false) || (ownMarks?.modDeafened ?? false);
  const statusClass = voiceState === "live" ? "live" : voiceState === "reconnecting" ? "reconnecting" : voiceState === "failed" ? "failed" : "connecting";
  const statusText = voiceState === "live"
    ? "Voice connected"
    : voiceState === "reconnecting"
      ? `Reconnecting…${stateDetail ? ` ${stateDetail}` : ""}`
      : voiceState === "failed"
        ? "Connection failed"
        : "Connecting…";

  return (
    <div className="voice-bar">
      <div className="voice-bar-info" onClick={toggleRoomView} title="Open / close the room view">
        <span className={"voice-bar-status " + statusClass}>{statusText}</span>
        <span className="voice-bar-details">
          {channel !== null ? `${channel.name} / ${session.hostUrl().replace(/^https?:\/\//, "")}` : ""}
        </span>
        <span className="voice-bar-open icon mdi-chevron-right" />
      </div>
      <div className="voice-bar-buttons">
        <button
          className={"voice-toggle icon-button" + (selfMuted ? " on" : "")}
          title={selfMuted ? "Unmute" : "Mute"}
          onClick={toggleSelfMute}
        >
          <span className={"icon " + (selfMuted ? "mdi-microphone-off" : "mdi-microphone")} style={{ fontSize: 16 }} />
        </button>
        <button
          className={"voice-toggle icon-button" + (selfDeafened ? " on" : "")}
          title={selfDeafened ? "Undeafen" : "Deafen"}
          onClick={toggleSelfDeafen}
        >
          <HeadphonesOffIcon size={16} />
        </button>
        <button
          className={"voice-toggle icon-button" + (apmEnabled ? "" : " on")}
          title={apmEnabled ? "Noise suppression: on — click to disable" : "Noise suppression: off — click to enable"}
          onClick={() => settingsStore.apply({ apmEnabled: !apmEnabled })}
        >
          <TriangleWaveIcon size={16} />
        </button>
        <button
          className={"voice-toggle icon-button" + (cameraOn ? " on" : "")}
          title={cameraOn ? "Camera off" : "Camera"}
          onClick={() => void toggleCamera()}
        >
          <span className={"icon " + (cameraOn ? "mdi-video" : "mdi-video-off")} style={{ fontSize: 16 }} />
        </button>
        <button
          className={"voice-toggle icon-button" + (sharing ? " on" : "")}
          title={sharing ? "Stop sharing" : "Share screen"}
          onClick={() => (sharing ? void stopShare() : setPickerOpen(true))}
        >
          <span className="icon mdi-cast-connected" style={{ fontSize: 16 }} />
        </button>
        <button className="voice-toggle icon-button leave" title="Disconnect" onClick={() => void leaveVoice()}>
          <span className="icon mdi-phone-hangup" style={{ fontSize: 16 }} />
        </button>
      </div>
      {pickerOpen ? (
        <SharePickerModal
          onClose={() => setPickerOpen(false)}
          onTarget={(target) => {
            setPickerOpen(false);
            void shareTarget(target);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The ROOM VIEW — the tile grid that swaps into the chat area while the voice
 * bar keeps the connection controls (oak's chatPane swap). HOT PATHS ARE
 * IMPERATIVE: speaking rings and meters update via refs on the 10 Hz audio
 * poll — no React re-render per frame (a re-render would rip the range
 * sliders out from under the cursor).
 */
export function RoomView({ session }: { session: ConnectionSession }): React.JSX.Element {
  const participants = useStore(appStore, (state) => state.participants);
  const cameraOn = useStore(appStore, (state) => state.cameraOn);
  const popoutActive = useStore(appStore, (state) => state.popoutActive);
  const viewingFeedId = useStore(appStore, (state) => state.viewingFeedId);
  const viewingUsername = useStore(appStore, (state) => state.viewingUsername);
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

  const channel = activeChannelId !== null ? session.channelStore.get(activeChannelId) : null;
  const screens = participants.filter((feed) => feed.streams.some((stream) => stream.type === "video")).length;

  return (
    <div className="room-view">
      <div className="room-view-header">
        <button className="voice-toggle icon-button" title="Back to chat" onClick={toggleRoomView}>
          <span className="icon mdi-chevron-left" style={{ fontSize: 16 }} />
        </button>
        <span className="icon mdi-volume-high" style={{ fontSize: 16, color: "var(--sp-text-dim)" }} />
        <span className="pane-title">{channel !== null ? channel.name : "Voice"}</span>
        <span className="room-view-sub">{participants.length + 1} in room{screens > 0 ? ` · ${screens} screen${screens > 1 ? "s" : ""}` : ""}</span>
      </div>
      <div className="room-view-body">
        {viewingFeedId !== null ? (
          <div className="share-panel">
            <div className="share-panel-head">
              <span><span className="icon mdi-monitor" style={{ fontSize: 14 }} /> {viewingUsername ?? "…"}'s screen</span>
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
      </div>
      {memberMenu !== null ? (
        <ContextMenu x={memberMenu.x} y={memberMenu.y} items={memberMenuItems} onClose={() => setMemberMenu(null)} />
      ) : null}
    </div>
  );
}
