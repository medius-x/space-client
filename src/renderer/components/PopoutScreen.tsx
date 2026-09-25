import { useEffect, useRef, useState } from "react";
import { PopoutViewer } from "../../core/popout-viewer";
import { NsEngineMenu } from "./VoiceRoom";
import { CaptionBar } from "./CaptionBar";
import type { NoiseEngineKind } from "../../media/noise-suppression";
import type { PopoutTarget, PopoutVoiceState } from "../bridges";
import { log } from "../../logging";

function isPopoutTarget(value: unknown): value is PopoutTarget {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.janusUrl === "string"
    && typeof record.roomId === "number"
    && (record.token === null || typeof record.token === "string")
    && (record.pin === null || typeof record.pin === "string")
    && typeof record.feedId === "number"
    && typeof record.videoMid === "string";
}

/** The target's optional share-audio fields, with safe defaults (a target from
 *  an older retarget predates them). */
function shareStateOf(target: PopoutTarget): { username: string | null; audio: boolean; volume: number } {
  const record = target as unknown as Record<string, unknown>;
  return {
    username: typeof record.shareUsername === "string" ? record.shareUsername : null,
    audio: record.shareAudio === true,
    volume: typeof record.shareVolume === "number" && Number.isFinite(record.shareVolume) ? record.shareVolume : 1,
  };
}

function isPopoutVoiceState(value: unknown): value is PopoutVoiceState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.muted === "boolean" && typeof record.deafened === "boolean" && typeof record.nsEngine === "string";
}

/** Silence window for incoming volume syncs after a LOCAL slider edit: the
 *  echo of our own drag (slider → IPC → setShareVolume → push back) must not
 *  fight the thumb mid-drag. */
const VOLUME_SYNC_GRACE_MS = 400;

/**
 * The share pop-out window's entire UI (2026-09-21 rework): its OWN videoroom
 * subscription — full quality and frame rate. A MediaStream cannot cross
 * Electron renderer contexts, which is why the old JPEG relay existed, but a
 * SECOND subscriber can: this window opens a private Janus session and takes
 * the watched feed's VIDEO stream (the main window owns the audio playout —
 * the pop-out's volume slider is a REMOTE for that playout, disabled when the
 * share carries no audio). The toolbar shows on hover and mirrors the main
 * window's voice panel (mute/deafen/NS) — presses travel back through IPC.
 */
export function PopoutScreen(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<PopoutViewer | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [shareUsername, setShareUsername] = useState<string | null>(null);
  const [shareAudio, setShareAudio] = useState(false);
  const [shareVolume, setShareVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [voiceState, setVoiceState] = useState<PopoutVoiceState>({ muted: false, deafened: false, nsEngine: "rnnoise" });
  const [nsMenuAt, setNsMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastLocalVolumeEditRef = useRef(0);

  const stopViewer = (): void => {
    viewerRef.current?.dispose();
    viewerRef.current = null;
    const element = videoRef.current;
    if (element) {
      element.srcObject = null;
    }
    setHasVideo(false);
  };

  const startViewer = (target: PopoutTarget): void => {
    stopViewer();
    const share = shareStateOf(target);
    setShareUsername(share.username);
    setShareAudio(share.audio);
    setShareVolume(share.volume);
    const viewer = new PopoutViewer({
      room: { janusUrl: target.janusUrl, roomId: target.roomId, token: target.token, pin: target.pin },
      feedId: target.feedId,
      videoMid: target.videoMid,
      onTrack: (track) => {
        const element = videoRef.current;
        if (!element) {
          return;
        }
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
        setHasVideo(true);
      },
      onGone: () => stopViewer(), // feed ended mid-watch → the waiting state
    });
    viewerRef.current = viewer;
    void viewer.start().catch((error: unknown) => {
      log.error("popout", `subscription failed: ${error instanceof Error ? error.message : String(error)}`);
      stopViewer();
    });
  };

  useEffect(() => {
    void window.spaceWindow?.popoutParams().then((target) => {
      if (isPopoutTarget(target)) {
        startViewer(target);
      }
    });
    void window.spaceWindow?.popoutVoiceState().then((state) => {
      if (isPopoutVoiceState(state)) {
        setVoiceState(state);
      }
    });
    window.spaceWindow?.onRetarget((target) => {
      if (isPopoutTarget(target)) {
        startViewer(target);
      } else {
        stopViewer();
      }
    });
    window.spaceWindow?.onPopoutVoiceState((state) => {
      if (isPopoutVoiceState(state)) {
        setVoiceState(state);
      }
    });
    window.spaceWindow?.onFullscreenChange((next) => {
      setFullscreen(next);
      // The window RESIZES on the flip — the pill jumps to a different corner
      // while the cursor sits still, so no pointermove will ever fire to
      // re-run the reveal test. Hide; the next cursor move re-reveals (live
      // report 2026-09-25: the panel stuck visible in/after fullscreen).
      setToolbarVisible(false);
    });
    return () => stopViewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the IPC sinks are single-shot by design
  }, []);

  // The volume-sync listener must see the CURRENT shareUsername without
  // re-subscribing: the ref is read at event time, not closure time.
  const shareUsernameRef = useRef<string | null>(null);
  shareUsernameRef.current = shareUsername;
  useEffect(() => {
    window.spaceWindow?.onPopoutVolumeSync((username, gain) => {
      if (username === shareUsernameRef.current && Date.now() - lastLocalVolumeEditRef.current > VOLUME_SYNC_GRACE_MS) {
        setShareVolume(gain);
      }
    });
  }, []);

  // Esc leaves fullscreen (Chromium does not auto-exit a programmatic
  // setFullScreen on Esc — that convenience belongs to the video element).
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        window.spaceWindow?.toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // Toolbar reveal (video-player semantics, driven by pointermove — CSS :hover
  // goes STALE after Chromium's leave-fullscreen transition, so it can never be
  // the mechanism): in the WINDOWED mode the pill appears when the cursor is
  // over/near the pill itself (user request); in FULLSCREEN any cursor movement
  // reveals it and a 2.5s idle timer hides it again. NO focus-holder: a click on
  // the pill's own button left activeElement inside it, and the holder then kept
  // the pill visible forever (live reports 2026-09-25 — "won't hide after
  // leaving fullscreen"); the NS menu being open is the only non-cursor holder.
  useEffect(() => {
    const hideDelayMs = 2500;
    let hideTimer: number | null = null;
    const onPointerMove = (event: PointerEvent): void => {
      const toolbar = toolbarRef.current;
      if (toolbar === null) {
        return;
      }
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (fullscreen) {
        setToolbarVisible(true);
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          setToolbarVisible(false);
        }, hideDelayMs);
        return;
      }
      const rect = toolbar.getBoundingClientRect();
      const hitMargin = 24; // a slightly generous invisible hit area
      const near = event.clientX >= rect.left - hitMargin && event.clientX <= rect.right + hitMargin
        && event.clientY >= rect.top - hitMargin && event.clientY <= rect.bottom + hitMargin;
      setToolbarVisible(near || nsMenuAt !== null);
    };
    window.addEventListener("pointermove", onPointerMove);
    // Leaving the WINDOW entirely: pointermove stops coming (the last one said
    // "inside") and the pill used to stay up forever (user-report detail
    // 2026-09-25). mouseleave on the document fires exactly then.
    const onMouseLeave = (): void => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      setToolbarVisible(nsMenuAt !== null);
    };
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [fullscreen, nsMenuAt]);

  // A plain window resize moves the anchored pill the same way a fullscreen
  // flip does — drop the stale reveal there too (the next pointermove
  // re-reveals if the cursor still covers the pill).
  useEffect(() => {
    const onResize = (): void => {
      setToolbarVisible(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const volumeInteractive = shareAudio && shareUsername !== null;
  const nsEngine = voiceState.nsEngine as NoiseEngineKind;

  return (
    <div className="popout-frame">
      <CaptionBar subtitle="Screen share" />
      <div className={"popout-root" + (fullscreen && !toolbarVisible ? " hide-cursor" : "")}>
        {/* display:none while streamless: a DEAD stream leaves the element
            sized (frozen last frame) inside the centering flex — the waiting
            line then sat OFF-CENTER next to it (live report 2026-09-25:
            sharer closed their client). */}
        <video ref={videoRef} autoPlay playsInline style={{ display: hasVideo ? "block" : "none" }} />
        {hasVideo ? null : <div className="popout-waiting">Waiting for the video…</div>}
        {hasVideo ? (
          <div ref={toolbarRef} className={"popout-toolbar" + (toolbarVisible ? " visible" : "")}>
            {/* The main window's voice panel, mirrored (user request): the same
                glyphs and on/off semantics; presses travel back via IPC. */}
            <button
              className={"popout-voice-toggle" + (voiceState.muted ? " on" : "")}
              title={voiceState.muted ? "Unmute" : "Mute"}
              onClick={() => window.spaceWindow?.popoutVoiceAction("toggle-mute")}
            >
              <span className={"icon " + (voiceState.muted ? "mdi-microphone-off" : "mdi-microphone")} />
            </button>
            <button
              className={"popout-voice-toggle" + (voiceState.deafened ? " on" : "")}
              title={voiceState.deafened ? "Undeafen" : "Deafen"}
              onClick={() => window.spaceWindow?.popoutVoiceAction("toggle-deafen")}
            >
              <span className={"icon " + (voiceState.deafened ? "mdi-headphones-off" : "mdi-headphones")} />
            </button>
            <button
              className={"popout-voice-toggle ns" + (nsEngine !== "off" ? " on" : "")}
              title="Noise suppression engine"
              onClick={(event) => {
                if (nsMenuAt !== null) {
                  setNsMenuAt(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setNsMenuAt({ x: rect.left, y: rect.top });
              }}
            >
              <span className="icon mdi-triangle-wave" />
            </button>
            <span className="popout-toolbar-sep" />
            <span className={"popout-toolbar-volume icon " + (volumeInteractive && shareVolume > 0 ? "mdi-volume-high" : "mdi-volume-off")} />
            <input
              className="popout-volume"
              type="range" min={0} max={2} step={0.01}
              value={shareVolume}
              disabled={!volumeInteractive}
              title={volumeInteractive ? "Share volume" : "This share has no audio"}
              onChange={(event) => {
                const next = event.currentTarget.valueAsNumber;
                lastLocalVolumeEditRef.current = Date.now();
                setShareVolume(next);
                if (shareUsername !== null) {
                  window.spaceWindow?.popoutVolume(shareUsername, next);
                }
              }}
            />
            <button
              className="popout-fullscreen"
              title={fullscreen ? "Exit full screen" : "Full screen"}
              onClick={() => window.spaceWindow?.toggleFullscreen()}
            >
              <span className={"icon " + (fullscreen ? "mdi-fullscreen-exit" : "mdi-fullscreen")} />
            </button>
          </div>
        ) : null}
        {nsMenuAt !== null ? (
          <NsEngineMenu
            engine={nsEngine}
            x={nsMenuAt.x}
            y={nsMenuAt.y}
            onPick={(next) => window.spaceWindow?.popoutVoiceAction("ns-engine", next)}
            onClose={() => setNsMenuAt(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
