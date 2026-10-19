import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { log } from "../../logging";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Attachment } from "../../types";

/**
 * Video player modal — the presigned URL goes straight into <video>; Chromium's
 * native streaming does the range requests. A dead link (played past its hour)
 * re-mints ONCE through /api/attachments/link and resumes at the death position.
 * Rendered through a PORTAL onto document.body: the modal mounts inside a
 * VirtualList row, and `position: fixed` is CLIPPED to any transformed ancestor
 * (tanstack virtual rows translate) — without the portal it is stuck to the
 * row instead of covering the window (live report).
 */
export function VideoModal({ session, attachment, onClose }: {
  session: ConnectionSession;
  attachment: Attachment;
  onClose(): void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recoveryTriedRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<"idle" | "busy" | "saved" | "failed">("idle");
  const savedResetTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (savedResetTimerRef.current !== null) {
      window.clearTimeout(savedResetTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async (): Promise<void> => {
    if (downloadState === "busy" || attachment.key === null) {
      return;
    }
    setDownloadState("busy");
    try {
      // The lightbox recipe: a fresh presigned link (the modal's src may be
      // an hour old) → bytes → the downloads folder (no OS dialog).
      const fresh = await session.rest.freshAttachmentLink(attachment.key);
      if (fresh === null) {
        setDownloadState("failed");
        return;
      }
      const bytes = new Uint8Array(await session.rest.downloadBytes(fresh));
      const saved = await window.spaceMedia?.saveFile(attachment.fileName, bytes);
      setDownloadState(saved !== null && saved !== undefined ? "saved" : "failed");
      if (saved !== null && saved !== undefined) {
        if (savedResetTimerRef.current !== null) {
          window.clearTimeout(savedResetTimerRef.current);
        }
        savedResetTimerRef.current = window.setTimeout(() => setDownloadState("idle"), 2000);
      }
    } catch (error: unknown) {
      log.warn("video", `download failed: ${error instanceof Error ? error.message : String(error)}`);
      setDownloadState("failed");
    }
  };

  const recover = async (): Promise<void> => {
    const video = videoRef.current;
    if (video === null || recoveryTriedRef.current || attachment.key === null) {
      log.warn("video", `load failed (no recovery path): src=${video?.src ?? "-"} key=${attachment.key ?? "-"}`);
      setStatus("link expired — open externally");
      return;
    }
    recoveryTriedRef.current = true;
    try {
      const diedAt = video.currentTime;
      const fresh = await session.rest.freshAttachmentLink(attachment.key);
      if (fresh === null) {
        log.warn("video", `load failed, fresh link is null: src=${video.src} key=${attachment.key}`);
        setStatus("link expired — open externally");
        return;
      }
      log.info("video", `recovery: ${video.src} -> ${fresh}`);
      video.src = fresh;
      video.currentTime = diedAt;
      void video.play();
      setStatus(null);
    } catch (error) {
      log.warn("video", `recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      setStatus("link expired — open externally");
    }
  };

  return createPortal(
    <div className="video-modal" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <div className="video-modal-body">
        <video
          ref={videoRef}
          src={attachment.url}
          controls
          autoPlay
          // TWO native escape hatches both bypass the downloads folder with
          // Chromium's own save dialog: the right-click "Save video as…" and
          // the player's kebab (⋮) Download item (live report 2026-10-19:
          // "three dots → save still shows a pick-a-folder dialog").
          // controlsList="nodownload" removes the kebab item; the context menu
          // is suppressed; the toolbar's Download button is the one true path.
          controlsList="nodownload"
          onContextMenu={(event) => event.preventDefault()}
          onError={() => void recover()}
        />
        {status !== null ? <div className="video-modal-status">{status}</div> : null}
        <div className="video-modal-toolbar">
          <span className="file-name">{attachment.fileName}</span>
          <button
            className="ghost"
            disabled={downloadState === "busy"}
            onClick={() => void download()}
            title="Download"
          >
            <span className={"icon " + (downloadState === "busy"
              ? "mdi-refresh sp-spin"
              : downloadState === "saved" ? "mdi-check" : "mdi-download")} />
          </button>
          {downloadState === "saved" ? <span className="video-modal-saved">Saved</span> : null}
          {downloadState === "failed" ? <span className="video-modal-status-inline">Save failed — see the log</span> : null}
          <button className="ghost" onClick={() => void window.spaceMedia?.openExternal(attachment.url)}>Open in browser</button>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
