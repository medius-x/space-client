import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  connectionDirectory,
  getCameraTrack,
  getVoiceShareTrack,
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
import { canActOn, memberNameColor, topPosition, type HierarchyView } from "../../domain/logic/roster-grouping";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { SharePickerModal } from "./SharePickerModal";
import { Avatar } from "./Avatar";

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
          <span className="icon mdi-microphone-off" />
        </span>
      ) : null}
      {deafenTone !== "none" ? (
        <span className={`voice-mark voice-mark-${deafenTone}`} title={deafenTone === "mod" ? "Deafened by a moderator" : "Deafened by themselves"}>
          <span className="icon mdi-headphones-off" />
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
/**
 * oak's NS-engine selector card (showNoiseEngineMenu port): one option row per
 * engine with the live one checkmarked; a pick applies locally (no signaling)
 * and closes. Our stack has two "engines": Chromium's built-in APM and Raw.
 */
export function NsEngineMenu({ apmEnabled, x, y, onPick, onClose }: {
  apmEnabled: boolean;
  x: number;
  y: number;
  onPick(next: boolean): void;
  onClose(): void;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useOutsideDismiss(cardRef, onClose);
  const options: { label: string; value: boolean }[] = [
    { label: "WebRTC (built-in)", value: true },
    { label: "Raw (off)", value: false },
  ];
  return (
    <div ref={cardRef} className="member-card engine-card" style={{ left: Math.max(8, x), top: Math.min(y, window.innerHeight - 120) }}>
      {options.map((option) => (
        <button
          key={option.label}
          className="engine-row"
          onClick={() => {
            onPick(option.value);
            onClose();
          }}
        >
          <span>{option.label}</span>
          {option.value === apmEnabled ? <span className="icon mdi-check" /> : null}
        </button>
      ))}
    </div>
  );
}

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
  const participants = useStore(appStore, (state) => state.participants);
  const screenCount = participants.filter((feed) => feed.streams.some((stream) => stream.type === "video")).length;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nsMenu, setNsMenu] = useState<{ x: number; y: number } | null>(null);

  if (activeChannelId === null) {
    return null; // no voice session — the card shrinks to the user bar alone
  }

  const ownMarks = marksByMember.get(session.username());
  const selfMuted = (ownMarks?.selfMuted ?? false) || (ownMarks?.modMuted ?? false);
  const selfDeafened = (ownMarks?.selfDeafened ?? false) || (ownMarks?.modDeafened ?? false);
  const statusClass = voiceState === "live" ? "live" : voiceState === "reconnecting" ? "reconnecting" : voiceState === "failed" ? "failed" : "connecting";
  // oak's voice bar texts (setVoiceStatus): "On a call" green / "Connecting"
  // yellow / "Reconnecting… N/5" yellow — over the "{channel}/{server}" detail line.
  const statusText = voiceState === "live"
    ? "On a call"
    : voiceState === "reconnecting"
      ? `Reconnecting…${stateDetail ? ` ${stateDetail}` : ""}`
      : voiceState === "failed"
        ? "Connection failed"
        : "Connecting";
  // oak's serverName (not the host URL) in the detail line — cachedServerName,
  // hostUrl only as a pre-profile fallback.
  const serverName = connectionDirectory.get(session.recordId)?.cachedServerName
    ?? session.hostUrl().replace(/^https?:\/\//, "");

  return (
    <div className="voice-bar">
      <div className="voice-bar-info" onClick={toggleRoomView} title="Open / close the room view">
        {/* oak stacks TWO lines: the colored status over the channel/server
            detail (voiceInfoRow VBox). NO chevron — the only chevron in the
            subsystem is the room header's back button (main.fxml has none here). */}
        <div className="voice-bar-text">
          <span className={"voice-bar-status " + statusClass}>{statusText}</span>
          <span className="voice-bar-details">
            {channel !== null ? `${channel.name} / ${serverName}` : ""}
          </span>
        </div>
        {screenCount > 0 ? (
          /* oak's voiceScreenBadge: green pill at the right end of the info row,
             lit on ANNOUNCE (streams arrive with the publishers list) — visible
             while reading chat with the room view closed. */
          <span className="voice-screen-badge">
            <span className="icon mdi-monitor" />
            {screenCount}
          </span>
        ) : null}
      </div>
      <div className="voice-bar-buttons">
        <button
          className={"voice-toggle icon-button" + (selfMuted ? " on" : "")}
          title={selfMuted ? "Unmute" : "Mute"}
          onClick={toggleSelfMute}
        >
          <span className={"icon " + (selfMuted ? "mdi-microphone-off" : "mdi-microphone")} />
        </button>
        <button
          className={"voice-toggle icon-button" + (selfDeafened ? " on" : "")}
          title={selfDeafened ? "Undeafen" : "Deafen"}
          onClick={toggleSelfDeafen}
        >
          {/* oak's deafen toggle swaps the glyph: plain headphones while hearing,
              crossed-out only while deafened (applySelfVoiceState). */}
          <span className={"icon " + (selfDeafened ? "mdi-headphones-off" : "mdi-headphones")} />
        </button>
        {/* oak: the NS button opens the ENGINE SELECTOR card; the button itself
            is green while an engine is active, grey on Raw (applyNoiseEngineState). */}
        <button
          className={"voice-toggle icon-button ns" + (apmEnabled ? " on" : "")}
          title={"Noise suppression: " + (apmEnabled ? "WebRTC (built-in)" : "Raw (off)")}
          onClick={(event) => setNsMenu({ x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().bottom + 4 })}
        >
          <span className="icon mdi-triangle-wave" />
        </button>
        {/* oak has NO separate camera button on the panel — the camera is a
            SOURCE inside the share picker. This one button is the single
            outgoing-video toggle: stop whatever is live, or open the picker. */}
        <button
          className={"voice-toggle icon-button share" + (sharing || cameraOn ? " on" : "")}
          title={sharing || cameraOn ? "Stop screen share" : "Share screen"}
          onClick={() => {
            if (cameraOn) {
              void toggleCamera(); // the toggle IS the camera's stop
            } else if (sharing) {
              void stopShare();
            } else {
              setPickerOpen(true);
            }
          }}
        >
          <span className="icon mdi-cast-connected" />
        </button>
        <button className="voice-toggle icon-button leave" title="Disconnect" onClick={() => void leaveVoice()}>
          <span className="icon mdi-phone-hangup" />
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
      {nsMenu !== null ? (
        <NsEngineMenu
          apmEnabled={apmEnabled}
          x={nsMenu.x}
          y={nsMenu.y}
          onPick={(next) => settingsStore.apply({ apmEnabled: next })}
          onClose={() => setNsMenu(null)}
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
  const sharing = useStore(appStore, (state) => state.sharing);
  const popoutActive = useStore(appStore, (state) => state.popoutActive);
  const viewingFeedId = useStore(appStore, (state) => state.viewingFeedId);
  const viewingUsername = useStore(appStore, (state) => state.viewingUsername);
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const marksByMember = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const shareVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const [speakingUsers, setSpeakingUsers] = useState<ReadonlySet<string>>(new Set());
  const [memberMenu, setMemberMenu] = useState<{ username: string; x: number; y: number } | null>(null);

  // Wire the runtime's imperative view hooks. The watched share binds INTO THE
  // OWNER'S TILE (oak's ParticipantTile) — there is no separate share panel.
  useEffect(() => {
    voiceView.attachShareVideo = (username: string, track: MediaStreamTrack) => {
      const element = shareVideoRefs.current.get(username);
      if (element) {
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
      }
    };
    voiceView.dropShareVideo = () => {
      for (const element of shareVideoRefs.current.values()) {
        element.srcObject = null;
      }
    };
    return () => {
      voiceView.attachShareVideo = () => undefined;
      voiceView.dropShareVideo = () => undefined;
    };
  }, []);

  // oak's speaking poll (pollSpeakingLevels): every 150 ms take the SNAPSHOT of
  // who is speaking and repaint the set — self-healing against a missed
  // "stopped" edge (the old per-tile class toggle left frames lit forever).
  // Closing the room view resets the set (stopSpeakingTimer parity).
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSpeakingUsers((previous) => {
        const next = roomAudio.speakingSnapshot();
        if (next.size === previous.size && [...next].every((username) => previous.has(username))) {
          return previous; // identity-stable — no re-render on an unchanged set
        }
        return next;
      });
    }, 150);
    return () => {
      window.clearInterval(timer);
      setSpeakingUsers(new Set());
    };
  }, []);

  // The pop-out's "closed" signal — stop pumping frames.
  useEffect(() => {
    window.spaceWindow?.onClosed(() => popoutClosed());
  }, []);

  // Own tile preview: the live LOCAL track — the camera OR the shared screen.
  useEffect(() => {
    const element = localVideoRef.current;
    if (!element) {
      return;
    }
    const track = cameraOn ? getCameraTrack() : sharing ? getVoiceShareTrack() : null;
    element.srcObject = track !== null ? new MediaStream([track]) : null;
  }, [cameraOn, sharing]);

  // Pop-out frame pump: grabs the WATCHED tile's <video> into a canvas → JPEG → IPC.
  useEffect(() => {
    if (!popoutActive || viewingFeedId === null || viewingUsername === null) {
      return;
    }
    const video = shareVideoRefs.current.get(viewingUsername) ?? null;
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
  }, [popoutActive, viewingFeedId, viewingUsername]);

  const setShareVideoRef = (username: string) => (element: HTMLVideoElement | null) => {
    if (element) {
      shareVideoRefs.current.set(username, element);
    } else {
      shareVideoRefs.current.delete(username);
    }
  };

  const nameColor = (username: string): string | null => {
    const member = members.find((entry) => entry.username === username);
    return member ? memberNameColor(member, roles) : null;
  };

  // oak's ParticipantTile: the CENTER is a fixed 260×146 screen slot — the
  // owner's avatar in idle, the live preview while watching (pop-out + stop
  // buttons, the plate reads "Sharing screen…" until the first frame covers
  // it), a Watch plate for an announced share, the LOCAL track for own camera/
  // share ("Your screen"/"Your camera"). The name (top-role color) + marks sit
  // BELOW; volumes live in the right-click card.
  const renderTile = (username: string, isSelf: boolean, feed: FeedInfo | null) => {
    const hasVideo = feed !== null && feed.streams.some((stream) => stream.type === "video");
    const watched = feed !== null && feed.feedId === viewingFeedId;
    const ownMedia = isSelf && (cameraOn || sharing);
    return (
      <div
        key={username}
        className={"tile"
          + (isSelf ? " self" : "")
          + (speakingUsers.has(username) ? " speaking" : "")}
        onContextMenu={isSelf ? undefined : (event) => {
          event.preventDefault();
          setMemberMenu({ username, x: event.clientX, y: event.clientY });
        }}
      >
        <div
          className="tile-screen-slot"
          onDoubleClick={() => {
            if (watched || ownMedia) {
              void openSharePopout();
            }
          }}
        >
          {isSelf && ownMedia ? (
            <>
              <div className="tile-slot-plate">{sharing ? "Your screen" : "Your camera"}</div>
              <video ref={localVideoRef} autoPlay playsInline muted />
            </>
          ) : isSelf ? (
            <Avatar session={session} username={username} size={100} />
          ) : hasVideo ? (
            watched ? (
              <>
                <div className="tile-slot-plate"><span className="icon mdi-monitor" /> Sharing screen…</div>
                <video ref={setShareVideoRef(username)} autoPlay playsInline />
              </>
            ) : (
              <button className="tile-slot-watch" onClick={() => setViewingFeed(feed!.feedId)}>
                <span className="icon mdi-monitor" /> Watch screen
              </button>
            )
          ) : (
            <Avatar session={session} username={username} size={100} />
          )}
        </div>
        <div className="tile-foot">
          <span className="tile-name" style={{ color: nameColor(username) ?? undefined }}>{username}{isSelf ? " (you)" : ""}</span>
          <VoiceMarks marks={marksByMember.get(username)} />
          {/* oak puts the pop-out / stop-watching buttons in the NAME ROW (right
              of the mute marks, 22×22 grey) — not floating over the preview. */}
          {watched ? (
            <>
              <button className="tile-action" title="Open in window" onClick={() => void openSharePopout()}>
                <span className="icon mdi-open-in-new" />
              </button>
              <button className="tile-action" title="Stop watching" onClick={() => setViewingFeed(feed!.feedId)}>
                <span className="icon mdi-eye-off" />
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  };

  const channel = activeChannelId !== null ? session.channelStore.get(activeChannelId) : null;
  const screens = participants.filter((feed) => feed.streams.some((stream) => stream.type === "video")).length;

  return (
    <div className="room-view">
      <div className="room-view-header">
        {/* oak's header order: grey voice glyph → title → "N in room · M screens"
            → stretch → the BACK button at the RIGHT edge (buildRoomView 4261-4276). */}
        <span className="icon mdi-volume-high" />
        <span className="pane-title">{channel !== null ? channel.name : "Voice room"}</span>
        <span className="room-view-sub">{participants.length + 1} in room{screens > 0 ? ` · ${screens} screen${screens > 1 ? "s" : ""}` : ""}</span>
        <button className="voice-toggle icon-button room-view-back" title="Back to chat" onClick={toggleRoomView}>
          <span className="icon mdi-chevron-left" />
        </button>
      </div>
      <div className="room-view-body">
        {/* No share panel above the grid (oak): the watched preview lives inside
            the owner's tile; the pop-out pump reads that tile's <video>. */}
        <div className="tile-grid">
          {renderTile(session.username(), true, null)}
          {/* oak's tile order: self FIRST, the rest alphabetical (rebuildRoomParticipants). */}
          {[...participants]
            .sort((left, right) => left.display.localeCompare(right.display))
            .map((feed) => renderTile(feed.display, false, feed))}
        </div>
      </div>
      {memberMenu !== null ? (
        <VoiceMemberCard
          session={session}
          username={memberMenu.username}
          hasShare={participants.some((feed) => feed.display === memberMenu.username && feed.streams.some((stream) => stream.type === "video"))}
          x={memberMenu.x}
          y={memberMenu.y}
          onClose={() => setMemberMenu(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The member card (right-click a room tile): personal volumes + moderation
// ---------------------------------------------------------------------------

/** One 0–200% volume row with a 0 ↔ last-positive mute toggle (oak's volume rows).
 *  The caption appears ONLY when both rows are visible (oak shows no caption on
 *  the lone voice slider) — label=null renders the row uncaptioned. */
function VolumeRow({ label, initialGain, onChange }: {
  label: string | null;
  initialGain: number;
  onChange(gain: number): void;
}): React.JSX.Element {
  const [gain, setGain] = useState(initialGain);
  const lastPositiveRef = useRef(initialGain > 0 ? initialGain : 1);
  return (
    <div className="volume-row">
      {label !== null ? <span className="volume-row-label">{label}</span> : null}
      <input
        type="range" min={0} max={200}
        value={Math.round(gain * 100)}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber / 100;
          if (next > 0) {
            lastPositiveRef.current = next;
          }
          setGain(next);
          onChange(next);
        }}
      />
      <button
        className={"icon-button volume-mute" + (gain === 0 ? " on" : "")}
        title={gain === 0 ? "Unmute" : "Mute"}
        onClick={() => {
          const next = gain === 0 ? lastPositiveRef.current : 0;
          setGain(next);
          onChange(next);
        }}
      >
        <span className={"icon " + (gain === 0 ? "mdi-volume-off" : "mdi-volume-high")} />
      </button>
    </div>
  );
}

/**
 * oak's voice-member card (showVoiceMemberMenu port): personal volumes on top —
 * "Voice" always, a second "Share audio" row while that member has an announced
 * share — and the moderation rows below (hidden without the permission).
 */
function VoiceMemberCard({ session, username, hasShare, x, y, onClose }: {
  session: ConnectionSession;
  username: string;
  hasShare: boolean;
  x: number;
  y: number;
  onClose(): void;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useOutsideDismiss(cardRef, onClose);
  const permissions = useStore(session.permissionStore, (state) => state.my?.permissions ?? []);
  const marks = useStore(session.voiceControlStore, (snapshot) => snapshot.marks.get(username));
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  // oak gates the moderation rows by permission AND the hierarchy hint
  // (voiceCanActOn: the owner is immune; otherwise strictly higher top position);
  // disallowed rows are HIDDEN, not disabled.
  const hierarchyOf = (memberUsername: string): HierarchyView => {
    const member = members.find((entry) => entry.username === memberUsername);
    return member === undefined
      ? { owner: false, topPosition: null }
      : { owner: member.owner, topPosition: topPosition(member, roles) };
  };
  const actable = canActOn(hierarchyOf(session.username()), hierarchyOf(username));
  const canMute = permissions.includes("MUTE_MEMBERS") && actable;
  const canDeafen = permissions.includes("DEAFEN_MEMBERS") && actable;
  const canKick = permissions.includes("MOVE_MEMBERS") && actable;

  const left = Math.min(Math.max(8, x), window.innerWidth - 250);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - (hasShare ? 190 : 150));
  return (
    <div ref={cardRef} className="member-card" style={{ left, top }}>
      <div className="member-card-title">{username}</div>
      <VolumeRow label={hasShare ? "Voice" : null} initialGain={persistedGain("voice", username)} onChange={(gain) => setVoiceVolume(username, gain)} />
      {hasShare ? (
        <VolumeRow label="Share audio" initialGain={persistedGain("share", username)} onChange={(gain) => setShareVolume(username, gain)} />
      ) : null}
      {canMute || canDeafen || canKick ? <div className="member-card-separator" /> : null}
      {canMute ? (
        <button className="member-card-action" onClick={() => { onClose(); serverMuteUser(username); }}>
          {marks?.modMuted ? "Unmute" : "Server mute"}
        </button>
      ) : null}
      {canDeafen ? (
        <button className="member-card-action" onClick={() => { onClose(); serverDeafenUser(username); }}>
          {marks?.modDeafened ? "Undeafen" : "Server deafen"}
        </button>
      ) : null}
      {canKick ? (
        <button className="member-card-action danger" onClick={() => { onClose(); kickVoiceUser(username); }}>
          Kick from voice
        </button>
      ) : null}
    </div>
  );
}
