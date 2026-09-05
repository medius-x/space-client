import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  acceptIncomingCall,
  appStore,
  callShareTarget,
  callView,
  getCallLocalVideoTrack,
  getCallPeerVideoTrack,
  hangUpCall,
  persistedGain,
  rejectIncomingCall,
  resolveCallConflict,
  roomAudio,
  setShareVolume,
  setVoiceVolume,
  stopCallShare,
  toggleCallCamera,
  toggleCallDeafen,
  toggleCallMic,
  isCallMicEnabled,
  type ShareTarget,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { Modal } from "./Modal";
import { SharePickerModal } from "./SharePickerModal";
import { HeadphonesOffIcon, TriangleWaveIcon } from "./MdiSvg";
import { settingsStore } from "../runtime";

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The in-call surface: a 2-tile view (self first), local controls (mic/deafen/camera/
 * share/hangup), the peer's per-stream volume sliders (they share the per-connection
 * record with voice rooms), and the ring cards for the pre-call states.
 */
export function CallPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const callState = useStore(appStore, (state) => state.callState);
  const callPeer = useStore(appStore, (state) => state.callPeer);
  const callHealthy = useStore(appStore, (state) => state.callHealthy);
  const callSeconds = useStore(appStore, (state) => state.callSeconds);
  const callCameraOn = useStore(appStore, (state) => state.callCameraOn);
  const callSharing = useStore(appStore, (state) => state.callSharing);
  const peerMicOn = useStore(appStore, (state) => state.peerMicOn);
  const peerDeafenedOn = useStore(appStore, (state) => state.peerDeafenedOn);
  const apmEnabled = useStore(settingsStore, (settings) => settings.apmEnabled);
  const peerCameraOn = useStore(appStore, (state) => state.peerCameraOn);
  const peerScreenOn = useStore(appStore, (state) => state.peerScreenOn);
  const ownUsername = session.username();

  const peerVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const peerTileMedia = peerScreenOn || peerCameraOn;

  // The imperative peer-video hook (the runtime routes the remote track here).
  useEffect(() => {
    callView.attachPeerVideo = (track: MediaStreamTrack) => {
      const element = peerVideoRef.current;
      if (element) {
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
      }
    };
    callView.dropPeerVideo = () => {
      const element = peerVideoRef.current;
      if (element) {
        element.srcObject = null;
      }
    };
    return () => {
      callView.attachPeerVideo = () => undefined;
      callView.dropPeerVideo = () => undefined;
    };
  }, []);

  // The self tile's preview: the camera OR the shared screen (whichever is live).
  useEffect(() => {
    const element = cameraVideoRef.current;
    if (!element) {
      return;
    }
    const track = callCameraOn || callSharing ? getCallLocalVideoTrack() : null;
    element.srcObject = track !== null ? new MediaStream([track]) : null;
  }, [callCameraOn, callSharing]);

  // The peer's video may have arrived before the <video> element mounted — re-bind on flip.
  useEffect(() => {
    if (!peerTileMedia) {
      return;
    }
    const element = peerVideoRef.current;
    if (!element || element.srcObject !== null) {
      return;
    }
    const track = getCallPeerVideoTrack();
    if (track !== null) {
      element.srcObject = new MediaStream([track]);
      void element.play().catch(() => undefined);
    }
  }, [peerTileMedia]);

  const onPick = (target: ShareTarget): void => {
    setPickerOpen(false);
    void callShareTarget(target);
  };

  return (
    <div className="call-pane">
      <div className={"call-status " + (callHealthy ? "healthy" : "reconnecting")}>
        {callState === "connecting"
          ? `Calling ${callPeer ?? "…"} — connecting…`
          : callHealthy
            ? `On a call with ${callPeer ?? "?"} — ${formatSeconds(callSeconds)}`
            : `Reconnecting… ${formatSeconds(callSeconds)}`}
      </div>
      <div className="call-tiles">
        <div className={"call-tile self" + (micOn ? "" : " mic-off")}>
          <div className="call-tile-head">
            <span className="call-tile-name">{ownUsername} (you)</span>
            {!micOn ? (
              <span className="voice-mark voice-mark-self" title="Your mic is muted">
                <span className="icon mdi-microphone-off" />
              </span>
            ) : null}
            {deafened ? (
              <span className="voice-mark voice-mark-self" title="You are deafened">
                <HeadphonesOffIcon size={11} />
              </span>
            ) : null}
          </div>
          {callCameraOn || callSharing ? (
            <video ref={cameraVideoRef} className="call-tile-video" autoPlay playsInline muted />
          ) : (
            <div className="call-tile-placeholder">{(ownUsername[0] ?? "?").toUpperCase()}</div>
          )}
        </div>
        <div className={"call-tile peer" + (peerMicOn ? "" : " mic-off")}>
          <div className="call-tile-head">
            <span className="call-tile-name">{callPeer ?? "?"}</span>
            {!peerMicOn ? (
              <span className="voice-mark voice-mark-self" title="Peer muted their mic">
                <span className="icon mdi-microphone-off" />
              </span>
            ) : null}
            {peerDeafenedOn ? (
              <span className="voice-mark voice-mark-self" title="Peer deafened themselves">
                <HeadphonesOffIcon size={11} />
              </span>
            ) : null}
          </div>
          {peerTileMedia ? (
            <video ref={peerVideoRef} className="call-tile-video" autoPlay playsInline />
          ) : (
            <div className="call-tile-placeholder">{(callPeer?.[0] ?? "?").toUpperCase()}</div>
          )}
        </div>
      </div>
      <div className="call-peer-volumes">
        <div className="tile-controls">
          <label>voice</label>
          <input
            type="range" min={0} max={200}
            defaultValue={String(Math.round(persistedGain("voice", callPeer ?? "") * 100))}
            onChange={(event) => callPeer !== null && setVoiceVolume(callPeer, event.currentTarget.valueAsNumber / 100)}
          />
        </div>
        <div className="tile-controls">
          <label>share</label>
          <input
            type="range" min={0} max={200}
            defaultValue={String(Math.round(persistedGain("share", callPeer ?? "") * 100))}
            onChange={(event) => callPeer !== null && setShareVolume(callPeer, event.currentTarget.valueAsNumber / 100)}
          />
        </div>
      </div>
      <div className="room-toolbar">
        <button
          className={"voice-toggle icon-button" + (micOn ? "" : " on")}
          title={micOn ? "Mute" : "Unmute"}
          onClick={() => {
            toggleCallMic();
            setMicOn(isCallMicEnabled());
          }}
        >
          <span className={"icon " + (micOn ? "mdi-microphone" : "mdi-microphone-off")} />
        </button>
        <button
          className={"voice-toggle icon-button" + (deafened ? " on" : "")}
          title={deafened ? "Undeafen" : "Deafen"}
          onClick={() => {
            toggleCallDeafen(); // deafen gates the mic too — both badges may flip
            setDeafened(roomAudio.isDeafened());
            setMicOn(isCallMicEnabled());
          }}
        >
          <HeadphonesOffIcon size={16} />
        </button>
        <button className={"voice-toggle icon-button" + (callCameraOn ? " on" : "")} title={callCameraOn ? "Camera off" : "Camera"} onClick={() => void toggleCallCamera()}>
          <span className={"icon " + (callCameraOn ? "mdi-video" : "mdi-video-off")} />
        </button>
        <button
          className={"voice-toggle icon-button" + (apmEnabled ? "" : " on")}
          title={apmEnabled ? "Noise suppression: on — click to disable" : "Noise suppression: off — click to enable"}
          onClick={() => settingsStore.apply({ apmEnabled: !apmEnabled })}
        >
          <TriangleWaveIcon size={16} />
        </button>
        <button
          className={"voice-toggle icon-button" + (callSharing ? " on" : "")}
          title={callSharing ? "Stop sharing" : "Share screen"}
          onClick={() => (callSharing ? void stopCallShare() : setPickerOpen(true))}
        >
          <span className="icon mdi-cast-connected" />
        </button>
        <button className="danger icon-button" title="Hang up" onClick={hangUpCall}>
          <span className="icon mdi-phone-hangup" />
        </button>
      </div>
      {pickerOpen ? <SharePickerModal onClose={() => setPickerOpen(false)} onTarget={onPick} /> : null}
    </div>
  );
}

/** The pre-call cards: incoming (Accept/Decline) and outgoing (Cancel). Fixed bottom-right. */
export function CallOverlayCard(): React.JSX.Element | null {
  const callState = useStore(appStore, (state) => state.callState);
  const callPeer = useStore(appStore, (state) => state.callPeer);
  if (callState !== "ringing-in" && callState !== "ringing-out") {
    return null;
  }
  const incoming = callState === "ringing-in";
  return (
    <div className="call-card">
      <div className="call-card-title">{incoming ? "Incoming call" : "Calling…"}</div>
      <div className="call-card-peer">{callPeer}</div>
      <div className="call-card-actions">
        {incoming ? (
          <>
            <button className="primary" onClick={acceptIncomingCall}>Accept</button>
            <button className="danger" onClick={rejectIncomingCall}>Decline</button>
          </>
        ) : (
          <button className="danger" onClick={hangUpCall}>Cancel</button>
        )}
      </div>
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
