import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  callShareTarget,
  callView,
  connectionDirectory,
  getCallLocalVideoTrack,
  getCallPeerVideoTrack,
  getCameraTrack,
  getVoiceRoomInfo,
  getVoiceShareTrack,
  hangUpCall,
  kickVoiceUser,
  leaveVoice,
  openSharePopout,
  persistedGain,
  popoutClosed,
  resolveCallConflict,
  roomAudio,
  serverDeafenUser,
  serverMuteUser,
  setShareVolume,
  setVoiceVolume,
  setViewingFeed,
  getFeedVideoTrack,
  settingsStore,
  shareTarget,
  stopCallShare,
  stopShare,
  toggleCallCamera,
  toggleCallDeafen,
  toggleCallMic,
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
import { feedHasLiveVideo } from "../../core/classifier";
import { displayNameOf } from "../../domain/logic/display-name";
import type { NoiseEngineKind } from "../../media/noise-suppression";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { SharePickerModal } from "./SharePickerModal";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import type { PopoutTarget } from "../bridges";

function formatCallSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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

/** oak's CALL badges: in a 1:1 both endpoints read as SELF-yellow — there is no
 *  moderator in a P2P call (MainController: the call's mute states are its own). */
export function CallMarks({ micOn, deafenedOn }: { micOn: boolean; deafenedOn: boolean }): React.JSX.Element | null {
  if (micOn && !deafenedOn) {
    return null;
  }
  return (
    <span className="voice-marks">
      {!micOn ? (
        <span className="voice-mark voice-mark-self" title="Muted">
          <span className="icon mdi-microphone-off" />
        </span>
      ) : null}
      {deafenedOn ? (
        <span className="voice-mark voice-mark-self" title="Deafened">
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
 *
 * A 1:1 CALL owns the same bar (oak: showCallVoiceBar) — the call never takes
 * the chat pane, its surfaces are this bar + the room view. The CALLER's ring
 * lives here too (user decision: no screen-corner card for the outgoing side,
 * the bar reads "Calling…" until answered).
 */
/**
 * oak's NS-engine selector card (showNoiseEngineMenu port): one option row per
 * engine with the live one checkmarked; a pick applies locally (a live voice
 * rebuilds the detour in place) and closes. The built-in WebRTC suppressor is
 * GONE (user decision): RNNoise replaces it, DeepFilterNet3 is the heavyweight
 * alternative, Off is a deliberately raw mic.
 */
export const NS_ENGINE_LABELS: Record<NoiseEngineKind, string> = {
  off: "Off",
  rnnoise: "RNNoise",
  deepfilternet3: "DeepFilterNet3",
  speex: "Speex",
  gate: "Gate",
  dtln: "DTLN",
};

/** The NS button's tooltip (oak): the click opens the engine selector card. */
function nsTitle(engine: NoiseEngineKind): string {
  return `Noise suppression: ${NS_ENGINE_LABELS[engine]}`;
}

/** The card renders UPWARDS and HUGS the button: the NS button sits at the
 *  BOTTOM of the voice bar, so the popup's LOWER edge anchors 6px above the
 *  button's top (translateY(-100%) — no fixed-height guessing); a repeated
 *  button click toggles the card closed. The callers pass the button's TOP. */
export function NsEngineMenu({ engine, x, y, onPick, onClose }: {
  engine: NoiseEngineKind;
  x: number;
  y: number;
  onPick(next: NoiseEngineKind): void;
  onClose(): void;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useOutsideDismiss(cardRef, onClose);
  const options: NoiseEngineKind[] = ["rnnoise", "deepfilternet3", "dtln", "speex", "gate", "off"];
  return (
    <div ref={cardRef} className="member-card engine-card" style={{ left: Math.max(8, x), top: Math.max(44, y - 6), transform: "translateY(-100%)" }}>
      {options.map((option) => (
        <button
          key={option}
          className="engine-row"
          onClick={() => {
            onPick(option);
            onClose();
          }}
        >
          <span>{NS_ENGINE_LABELS[option]}</span>
          {option === engine ? <span className="icon mdi-check" /> : null}
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
  const activeChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const nsEngine = useStore(settingsStore, (settings) => settings.noiseSuppressionEngine);
  const participants = useStore(appStore, (state) => state.participants);
  const marksByMember = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  // The rename model: the peer's rendered name resolves through the live roster.
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const callState = useStore(appStore, (state) => state.callState);
  const callPeer = useStore(appStore, (state) => state.callPeer);
  const callHealthy = useStore(appStore, (state) => state.callHealthy);
  const callSeconds = useStore(appStore, (state) => state.callSeconds);
  const callMicOn = useStore(appStore, (state) => state.callMicOn);
  const callDeafenedOn = useStore(appStore, (state) => state.callDeafenedOn);
  const callCameraOn = useStore(appStore, (state) => state.callCameraOn);
  const callSharing = useStore(appStore, (state) => state.callSharing);
  const peerMicOn = useStore(appStore, (state) => state.peerMicOn);
  const peerCameraOn = useStore(appStore, (state) => state.peerCameraOn);
  const peerScreenOn = useStore(appStore, (state) => state.peerScreenOn);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nsMenu, setNsMenu] = useState<{ x: number; y: number } | null>(null);

  // The bar owns the CALLER's ring (user decision) and the accepted call — but
  // NOT the callee's ring: oak's RINGING states own no surface, the callee's
  // ring lives in the toast-window card alone.
  const inCall = callState === "ringing-out" || callState === "connecting" || callState === "in-call";
  if (activeChannelId === null && !inCall) {
    return null; // no voice session and no call — the card shrinks to the user bar alone
  }

  // oak's serverName (not the host URL) in the detail line — cachedServerName,
  // hostUrl only as a pre-profile fallback.
  const serverName = connectionDirectory.get(session.recordId)?.cachedServerName
    ?? session.hostUrl().replace(/^https?:\/\//, "");

  if (inCall) {
    // The call bar (oak's showCallVoiceBar): "Calling…" while the caller rings
    // (user decision — the outgoing side gets NO screen-corner card), then the
    // oak statuses. The short accept→offer phase reads "Connecting…" (honest —
    // oak skips the stage entirely; our timer starts on "On a call").
    const ringingOut = callState === "ringing-out";
    const statusClass = callState === "in-call"
      ? (callHealthy ? "live" : "reconnecting")
      : "connecting";
    const statusText = ringingOut
      ? "Calling…"
      : callState === "connecting"
        ? "Connecting…"
        : callState === "in-call"
          ? (callHealthy ? (callSeconds > 0 ? `On a call — ${formatCallSeconds(callSeconds)}` : "On a call") : "Reconnecting…")
          : "On a call";
    // oak's voiceScreenBadge equivalent: the peer's announced camera/screen.
    const peerScreens = (peerScreenOn || peerCameraOn) ? 1 : 0;
    return (
      <div className="voice-bar">
        <div className="voice-bar-info" onClick={toggleRoomView} title="Open / close the call view">
          <div className="voice-bar-text">
            <span className={"voice-bar-status " + statusClass}>{statusText}</span>
            <span className="voice-bar-details">{callPeer !== null ? `${displayNameOf(rosterUsers, callPeer)} / ${serverName}` : ""}</span>
          </div>
          {peerScreens > 0 ? (
            <span className="voice-screen-badge">
              <span className="icon mdi-monitor" />
              {peerScreens}
            </span>
          ) : null}
        </div>
        {/* The caller's ring keeps the local toggles usable (user decision:
            mute/deafen/NS act on the ALREADY-captured mic). Camera/screen
            sharing can only be NEGOTIATED in the offer — that button waits
            for the connection. */}
        <div className="voice-bar-buttons">
          <button
            className={"voice-toggle icon-button" + (callMicOn ? "" : " on")}
            title={callMicOn ? "Mute" : "Unmute"}
            onClick={toggleCallMic}
          >
            <span className={"icon " + (callMicOn ? "mdi-microphone" : "mdi-microphone-off")} />
          </button>
          <button
            className={"voice-toggle icon-button" + (callDeafenedOn ? " on" : "")}
            title={callDeafenedOn ? "Undeafen" : "Deafen"}
            onClick={toggleCallDeafen}
          >
            <span className={"icon " + (callDeafenedOn ? "mdi-headphones-off" : "mdi-headphones")} />
          </button>
          <button
            className={"voice-toggle icon-button ns" + (nsEngine !== "off" ? " on" : "")}
            title={nsTitle(nsEngine)}
            onClick={(event) => setNsMenu(nsMenu === null ? { x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().top } : null)}
          >
            <span className="icon mdi-triangle-wave" />
          </button>
          {/* oak has NO separate camera button — the camera is a SOURCE inside
              the share picker; one toggle stops whatever is live. While the
              callee is still RINGING the button is visible but disabled: the
              video slot is only negotiated in the offer that follows ACCEPT. */}
          <button
            className={"voice-toggle icon-button share" + (callSharing || callCameraOn ? " on" : "")}
            disabled={ringingOut}
            title={ringingOut ? "Available once the call connects" : callSharing || callCameraOn ? "Stop screen share" : "Share screen"}
            onClick={() => {
              if (callCameraOn) {
                void toggleCallCamera(); // the toggle IS the camera's stop
              } else if (callSharing) {
                void stopCallShare();
              } else {
                setPickerOpen(true);
              }
            }}
          >
            <span className="icon mdi-cast-connected" />
          </button>
          <button className="voice-toggle icon-button leave" title={ringingOut ? "Cancel" : "Hang up"} onClick={hangUpCall}>
            <span className="icon mdi-phone-hangup" />
          </button>
        </div>
        {pickerOpen ? (
          <SharePickerModal
            onClose={() => setPickerOpen(false)}
            onTarget={(target) => {
              setPickerOpen(false);
              void callShareTarget(target);
            }}
          />
        ) : null}
        {nsMenu !== null ? (
          <NsEngineMenu
            engine={nsEngine}
            x={nsMenu.x}
            y={nsMenu.y}
            onPick={(next) => settingsStore.apply({ noiseSuppressionEngine: next })}
            onClose={() => setNsMenu(null)}
          />
        ) : null}
      </div>
    );
  }

  const channel = activeChannelId !== null ? session.channelStore.get(activeChannelId) : null;
  const screenCount = participants.filter(feedHasLiveVideo).length;

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
            is green while an engine runs, grey on Off (applyNoiseEngineState). */}
        <button
          className={"voice-toggle icon-button ns" + (nsEngine !== "off" ? " on" : "")}
          title={nsTitle(nsEngine)}
          onClick={(event) => setNsMenu(nsMenu === null ? { x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().top } : null)}
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
          engine={nsEngine}
          x={nsMenu.x}
          y={nsMenu.y}
          onPick={(next) => settingsStore.apply({ noiseSuppressionEngine: next })}
          onClose={() => setNsMenu(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The ROOM VIEW — the tile grid that swaps into the chat area while the voice
 * bar keeps the connection controls (oak's chatPane swap). A 1:1 CALL renders
 * through the SAME view as a degenerate two-participant room (oak: one
 * showRoomView/ParticipantTile, dispatched by roomIsCall). HOT PATHS ARE
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
  const callState = useStore(appStore, (state) => state.callState);
  const callPeer = useStore(appStore, (state) => state.callPeer);
  const callMicOn = useStore(appStore, (state) => state.callMicOn);
  const callDeafenedOn = useStore(appStore, (state) => state.callDeafenedOn);
  const callCameraOn = useStore(appStore, (state) => state.callCameraOn);
  const callSharing = useStore(appStore, (state) => state.callSharing);
  const peerMicOn = useStore(appStore, (state) => state.peerMicOn);
  const peerDeafenedOn = useStore(appStore, (state) => state.peerDeafenedOn);
  const peerCameraOn = useStore(appStore, (state) => state.peerCameraOn);
  const peerScreenOn = useStore(appStore, (state) => state.peerScreenOn);
  const marksByMember = useStore(session.voiceControlStore, (snapshot) => snapshot.marks);
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  // The rename model: tile names resolve through the live roster (the username
  // stays the lookup key for marks/volumes and never renders).
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  const nameOf = (username: string): string => displayNameOf(rosterUsers, username);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const callSelfVideoRef = useRef<HTMLVideoElement | null>(null);
  const callPeerVideoRef = useRef<HTMLVideoElement | null>(null);
  const shareVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const [speakingUsers, setSpeakingUsers] = useState<ReadonlySet<string>>(new Set());
  const [memberMenu, setMemberMenu] = useState<{ username: string; x: number; y: number } | null>(null);
  /** True once the peer's video track actually landed in the <video> element —
   *  the "Sharing screen…" plate reads until then (oak's renameRemoteScreen). */
  const [callPeerVideoReady, setCallPeerVideoReady] = useState(false);

  const callMode = callState === "connecting" || callState === "in-call";
  const callPeerMedia = peerScreenOn || peerCameraOn;

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

  // A re-watch must re-bind the RETAINED video track: Janus recycles the
  // subscriber m-line for a publisher's next share — the same receiver.track
  // mutes and unmutes, ontrack never re-fires, so the fresh view mount is the
  // only re-bind moment (a genuinely fresh track overrides it on delivery).
  useEffect(() => {
    if (viewingFeedId === null) {
      return;
    }
    const retained = getFeedVideoTrack(viewingFeedId);
    const element = retained !== null ? shareVideoRefs.current.get(retained.username) : null;
    if (element !== null && element !== undefined && retained !== null) {
      element.srcObject = new MediaStream([retained.track]);
      void element.play().catch(() => undefined);
    }
  }, [viewingFeedId, participants]);

  // The call's peer-video hook (the runtime routes the remote track here) —
  // mounted only in call mode; the track may have arrived before this render.
  useEffect(() => {
    if (!callMode) {
      return;
    }
    callView.attachPeerVideo = (track: MediaStreamTrack) => {
      const element = callPeerVideoRef.current;
      setCallPeerVideoReady(true);
      if (element) {
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
      }
    };
    callView.dropPeerVideo = () => {
      setCallPeerVideoReady(false);
      const element = callPeerVideoRef.current;
      if (element) {
        element.srcObject = null;
      }
    };
    return () => {
      callView.attachPeerVideo = () => undefined;
      callView.dropPeerVideo = () => undefined;
    };
  }, [callMode]);

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

  // Own tile preview (VOICE ROOM): the live LOCAL track — the camera OR the shared screen.
  useEffect(() => {
    const element = localVideoRef.current;
    if (!element) {
      return;
    }
    const track = cameraOn ? getCameraTrack() : sharing ? getVoiceShareTrack() : null;
    element.srcObject = track !== null ? new MediaStream([track]) : null;
  }, [cameraOn, sharing]);

  // Own tile preview (CALL): same rule, the call's local track.
  useEffect(() => {
    const element = callSelfVideoRef.current;
    if (!element) {
      return;
    }
    const track = callCameraOn || callSharing ? getCallLocalVideoTrack() : null;
    element.srcObject = track !== null ? new MediaStream([track]) : null;
  }, [callCameraOn, callSharing]);

  // The peer's video may have arrived before the <video> element mounted — re-bind on flip.
  useEffect(() => {
    if (!callMode || !callPeerMedia) {
      return;
    }
    const element = callPeerVideoRef.current;
    if (!element || element.srcObject !== null) {
      return;
    }
    const track = getCallPeerVideoTrack();
    if (track !== null) {
      element.srcObject = new MediaStream([track]);
      void element.play().catch(() => undefined);
      setCallPeerVideoReady(true);
    }
  }, [callMode, callPeerMedia]);

  // Pop-out target sync: the pop-out window runs its OWN videoroom subscription
  // (the old 12.5 fps JPEG relay is gone). This effect only keeps its TARGET in
  // step with what the main window watches — identical consecutive targets are
  // skipped so an unrelated roster update never resubscribes the window.
  const lastPopoutTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!popoutActive) {
      return;
    }
    let target: PopoutTarget | null = null;
    if (viewingFeedId !== null) {
      const room = getVoiceRoomInfo();
      const feed = participants.find((entry) => entry.feedId === viewingFeedId);
      const videoMid = feed?.streams.find((stream) => stream.type === "video" && stream.disabled !== true)?.mid;
      if (room !== null && videoMid !== undefined) {
        target = {
          janusUrl: room.janusUrl,
          roomId: room.roomId,
          token: room.token,
          pin: room.pin,
          feedId: viewingFeedId,
          videoMid,
        };
      }
    }
    const fingerprint = target === null ? "null" : JSON.stringify(target);
    if (fingerprint === lastPopoutTargetRef.current) {
      return;
    }
    lastPopoutTargetRef.current = fingerprint;
    window.spaceWindow?.retargetPopout(target);
  }, [popoutActive, viewingFeedId, participants]);

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
    const hasVideo = feed !== null && feedHasLiveVideo(feed);
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
          <span className="tile-name" style={{ color: nameColor(username) ?? undefined }}>{nameOf(username)}{isSelf ? " (you)" : ""}</span>
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

  // The CALL tiles — the same ParticipantTile shape, fed by the call machine
  // instead of the SFU (oak: roomParticipants() = {self, callPeer}). No Watch
  // mechanics: one video m-line, frames flow on their own.
  const renderCallTile = (username: string, isSelf: boolean) => {
    const ownMedia = isSelf && (callCameraOn || callSharing);
    return (
      <div
        key={isSelf ? "call-self" : "call-peer"}
        className={"tile"
          + (isSelf ? " self" : "")
          + (speakingUsers.has(username) ? " speaking" : "")}
        onContextMenu={isSelf ? undefined : (event) => {
          event.preventDefault();
          setMemberMenu({ username, x: event.clientX, y: event.clientY });
        }}
      >
        <div className="tile-screen-slot">
          {isSelf && ownMedia ? (
            <>
              <div className="tile-slot-plate">{callSharing ? "Your screen" : "Your camera"}</div>
              <video ref={callSelfVideoRef} autoPlay playsInline muted />
            </>
          ) : isSelf ? (
            <Avatar session={session} username={username} size={100} />
          ) : callPeerMedia ? (
            <>
              {callPeerVideoReady ? null : (
                <div className="tile-slot-plate"><span className="icon mdi-monitor" /> Sharing screen…</div>
              )}
              <video ref={callPeerVideoRef} autoPlay playsInline />
            </>
          ) : (
            <Avatar session={session} username={username} size={100} />
          )}
        </div>
        <div className="tile-foot">
          <span className="tile-name" style={{ color: nameColor(username) ?? undefined }}>{nameOf(username)}{isSelf ? " (you)" : ""}</span>
          {isSelf
            ? <CallMarks micOn={callMicOn} deafenedOn={callDeafenedOn} />
            : <CallMarks micOn={peerMicOn} deafenedOn={peerDeafenedOn} />}
        </div>
      </div>
    );
  };

  const channel = activeChannelId !== null ? session.channelStore.get(activeChannelId) : null;
  const screens = participants.filter(feedHasLiveVideo).length;

  return (
    <div className="room-view">
      <div className="room-view-header">
        {/* oak's header order: grey voice glyph → title → "N in room · M screens"
            → stretch → the BACK button at the RIGHT edge (buildRoomView 4261-4276).
            In a call the title is the PEER's name (roomTitleLabel = callPeer). */}
        <span className="icon mdi-volume-high" />
        <span className="pane-title">{callMode ? nameOf(callPeer ?? "") : channel !== null ? channel.name : "Voice room"}</span>
        <span className="room-view-sub">
          {callMode
            ? `2 in room${callPeerMedia ? " · 1 screen" : ""}`
            : `${participants.length + 1} in room${screens > 0 ? ` · ${screens} screen${screens > 1 ? "s" : ""}` : ""}`}
        </span>
        <button className="voice-toggle icon-button room-view-back" title="Back to chat" onClick={toggleRoomView}>
          <span className="icon mdi-chevron-left" />
        </button>
      </div>
      <div className="room-view-body">
        {/* No share panel above the grid (oak): the watched preview lives inside
            the owner's tile; the pop-out pump reads that tile's <video>. */}
        <div className="tile-grid">
          {callMode ? (
            <>
              {renderCallTile(session.username(), true)}
              {callPeer !== null ? renderCallTile(callPeer, false) : null}
            </>
          ) : (
            <>
              {renderTile(session.username(), true, null)}
              {/* oak's tile order: self FIRST, the rest alphabetical (rebuildRoomParticipants). */}
              {[...participants]
                .sort((left, right) => left.display.localeCompare(right.display))
                .map((feed) => renderTile(feed.display, false, feed))}
            </>
          )}
        </div>
      </div>
      {memberMenu !== null ? (
        <VoiceMemberCard
          session={session}
          username={memberMenu.username}
          hasShare={callMode
            ? peerScreenOn
            : participants.some((feed) => feed.display === memberMenu.username && feedHasLiveVideo(feed))}
          moderation={!callMode}
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
 * share — and the moderation rows below (hidden without the permission). In a
 * CALL the card is volumes ONLY (oak's showCallVolumeMenu — no moderation in P2P).
 * Shared by the room-view tiles and the sidebar's voice-member rows.
 */
export function VoiceMemberCard({ session, username, hasShare, moderation = true, x, y, onClose }: {
  session: ConnectionSession;
  username: string;
  hasShare: boolean;
  moderation?: boolean;
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
  const canMute = moderation && permissions.includes("MUTE_MEMBERS") && actable;
  const canDeafen = moderation && permissions.includes("DEAFEN_MEMBERS") && actable;
  const canKick = moderation && permissions.includes("MOVE_MEMBERS") && actable;

  const left = Math.min(Math.max(8, x), window.innerWidth - 250);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - (hasShare ? 190 : 150));
  // The rename model: the card's heading is the NICKNAME from the live roster.
  const rosterUsers = useStore(session.rosterStore, (state) => state.users);
  return (
    <div ref={cardRef} className="member-card" style={{ left, top }}>
      <div className="member-card-title">{displayNameOf(rosterUsers, username)}</div>
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

/** The room↔call exclusivity question (oak parity: both directions ask). */
export function CallConflictModal(): React.JSX.Element | null {
  const conflict = useStore(appStore, (state) => state.callConflict);
  if (conflict === null) {
    return null;
  }
  const description = conflict.kind === "start-call"
    ? `Calling ${conflict.peer} will disconnect you from the voice room.`
    : conflict.kind === "accept-call"
      ? `Accepting ${conflict.peer}'s call will disconnect you from the voice room.`
      : `Joining the voice room will end your call with ${conflict.peer}.`;
  return (
    <Modal title="Are you sure?" onClose={() => resolveCallConflict(false)}>
      <div className="modal-note">{description}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={() => resolveCallConflict(false)}>Cancel</button>
        <button className="danger" onClick={() => resolveCallConflict(true)}>Continue</button>
      </div>
    </Modal>
  );
}
