import { useEffect, useRef, useState } from "react";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Attachment } from "../../types";
import { log } from "../../logging";

/**
 * Full-image viewer: wheel zoom toward the cursor, drag pan (clamped at fit),
 * double-click reset, ←/→ within the message's images, Esc close, Save through
 * the OS dialog (fresh link first — the visible URL may have aged out).
 */
const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function Lightbox({ session, images, startIndex, onClose }: {
  session: ConnectionSession;
  images: readonly Attachment[];
  startIndex: number;
  onClose(): void;
}): React.JSX.Element {
  const [index, setIndex] = useState(startIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const attachment = images[index] ?? null;
  const url = useAttachmentImage(
    session,
    attachment !== null && attachment.key !== null ? { key: attachment.key, url: attachment.url } : null,
  );

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        setIndex(index - 1);
        reset();
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        setIndex(index + 1);
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose]);

  const save = async () => {
    if (attachment === null || attachment.key === null || busy) {
      return;
    }
    setBusy(true);
    try {
      const fresh = await session.rest.freshAttachmentLink(attachment.key);
      if (fresh === null) {
        return;
      }
      const bytes = new Uint8Array(await session.rest.downloadBytes(fresh));
      await window.spaceMedia?.saveFile(attachment.fileName, bytes);
    } catch (error) {
      log.warn("lightbox", `save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="lightbox"
      onWheel={(event) => {
        const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
        setScale((previous) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous * factor)));
      }}
      onMouseDown={(event) => {
        dragStateRef.current = { startX: event.clientX, startY: event.clientY, baseX: offset.x, baseY: offset.y };
      }}
      onMouseMove={(event) => {
        const drag = dragStateRef.current;
        if (drag === null) {
          return;
        }
        setOffset({ x: drag.baseX + event.clientX - drag.startX, y: drag.baseY + event.clientY - drag.startY });
      }}
      onMouseUp={() => {
        dragStateRef.current = null;
      }}
      onMouseLeave={() => {
        dragStateRef.current = null;
      }}
      onDoubleClick={reset}
    >
      {url !== null ? (
        <img
          className="lightbox-image"
          src={url}
          alt={attachment?.fileName ?? ""}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      ) : (
        <div className="lightbox-status">loading…</div>
      )}
      <div className="lightbox-toolbar">
        <button className="ghost" disabled={index === 0} onClick={() => { setIndex(index - 1); reset(); }}>←</button>
        <span className="lightbox-counter">{images.length > 1 ? `${index + 1}/${images.length}` : ""}</span>
        <button className="ghost" disabled={index >= images.length - 1} onClick={() => { setIndex(index + 1); reset(); }}>→</button>
        <button className="ghost" disabled={busy} onClick={() => void save()}>Save</button>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
