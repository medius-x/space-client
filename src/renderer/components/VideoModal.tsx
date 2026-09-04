import { useEffect, useRef, useState } from "react";
import { log } from "../../logging";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Attachment } from "../../types";

/**
 * Video player modal — the presigned URL goes straight into <video>; Chromium's
 * native streaming does the range requests. A dead link (played past its hour)
 * re-mints ONCE through /api/attachments/link and resumes at the death position.
 */
export function VideoModal({ session, attachment, onClose }: {
  session: ConnectionSession;
  attachment: Attachment;
  onClose(): void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recoveryTriedRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const recover = async (): Promise<void> => {
    const video = videoRef.current;
    if (video === null || recoveryTriedRef.current || attachment.key === null) {
      setStatus("link expired — open externally");
      return;
    }
    recoveryTriedRef.current = true;
    try {
      const diedAt = video.currentTime;
      const fresh = await session.rest.freshAttachmentLink(attachment.key);
      if (fresh === null) {
        setStatus("link expired — open externally");
        return;
      }
      video.src = fresh;
      video.currentTime = diedAt;
      void video.play();
      setStatus(null);
    } catch (error) {
      log.warn("video", `recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      setStatus("link expired — open externally");
    }
  };

  return (
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
          onError={() => void recover()}
        />
        {status !== null ? <div className="video-modal-status">{status}</div> : null}
        <div className="video-modal-toolbar">
          <span className="file-name">{attachment.fileName}</span>
          <button className="ghost" onClick={() => void window.spaceMedia?.openExternal(attachment.url)}>Open in browser</button>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
      </div>
    </div>
  );
}
