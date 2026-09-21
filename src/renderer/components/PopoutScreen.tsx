import { useEffect, useRef, useState } from "react";
import { PopoutViewer } from "../../core/popout-viewer";
import type { PopoutTarget } from "../bridges";
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

/**
 * The share pop-out window's entire UI (2026-09-21 rework): its OWN videoroom
 * subscription — full quality and frame rate. A MediaStream cannot cross
 * Electron renderer contexts, which is why the old JPEG relay existed, but a
 * SECOND subscriber can: this window opens a private Janus session and takes
 * the watched feed's VIDEO stream (the main window owns the audio playout).
 */
export function PopoutScreen(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<PopoutViewer | null>(null);
  const [hasVideo, setHasVideo] = useState(false);

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
    window.spaceWindow?.onRetarget((target) => {
      if (isPopoutTarget(target)) {
        startViewer(target);
      } else {
        stopViewer();
      }
    });
    return () => stopViewer();
  }, []);

  return (
    <div className="popout-root">
      <video ref={videoRef} autoPlay playsInline />
      {hasVideo ? null : <div className="popout-waiting">Waiting for the video…</div>}
    </div>
  );
}
