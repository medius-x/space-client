import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Attachment } from "../../types";
import { log } from "../../logging";
import {
  initialTransform,
  panTransform,
  zoomAt,
  type ViewerTransform,
} from "../../domain/logic/image-viewer-transform";
import { humanByteSize } from "../../domain/logic/file-size";

/**
 * Full-image viewer (oak's AttachmentViewer): wheel zoom TOWARD THE CURSOR,
 * drag pan CLAMPED to the image (an axis that fits stays pinned center),
 * double-click reset to the opening state, ←/→ within the message's images,
 * Esc close. The toolbar is oak's set: Download (OS save dialog, fresh link
 * first), Forward (the message's forward flow), Open in browser, Copy to
 * clipboard (through a PNG canvas), and a Details card (name/type/dimensions/
 * size — the size is fetched on first open, the DTO carries none).
 *
 * Rendered through a PORTAL onto document.body: the viewer mounts inside a
 * VirtualList row, and `position: fixed` is CLIPPED to any transformed
 * ancestor (tanstack virtual rows translate) — without the portal it is
 * stuck to the row instead of covering the window (live report).
 */
export function Lightbox({ session, images, startIndex, onForwardBegin, onClose }: {
  session: ConnectionSession;
  images: readonly Attachment[];
  startIndex: number;
  /** "Forward" opens the message's forward flow (the dialog lives in ChatPane). */
  onForwardBegin?: () => void;
  onClose(): void;
}): React.JSX.Element {
  const [index, setIndex] = useState(startIndex);
  const [transform, setTransform] = useState<ViewerTransform>({ baseScale: 1, scale: 1, offsetX: 0, offsetY: 0 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Download receipt: the glyph flips to a check for a couple of seconds. */
  const [savedFlash, setSavedFlash] = useState(false);
  /** The Details card's anchor (the button's top-left) — null = closed; a second
   *  press on the button toggles it back (live report). */
  const [detailsAnchor, setDetailsAnchor] = useState<{ x: number; y: number } | null>(null);
  const [detailsByteSize, setDetailsByteSize] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const dragStateRef = useRef<{ lastX: number; lastY: number } | null>(null);
  // The press point of the current gesture — separates a backdrop CLICK from
  // the tail of a pan that happened to end on the backdrop.
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const attachment = images[index] ?? null;
  const url = useAttachmentImage(
    session,
    attachment !== null && attachment.key !== null ? { key: attachment.key, url: attachment.url } : null,
  );

  // A new image starts from the fitted, centered state (also the dbl-click reset).
  const reset = () => {
    const stage = stageRef.current;
    if (stage !== null && imageSize !== null) {
      setTransform(initialTransform({ width: stage.clientWidth, height: stage.clientHeight }, imageSize.width, imageSize.height));
    }
  };

  useEffect(() => {
    setImageSize(null);
    setDetailsAnchor(null);
    setDetailsByteSize(null);
    setCopied(false);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        setIndex(index - 1);
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        setIndex(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose]);

  const viewport = () => {
    const stage = stageRef.current;
    return stage !== null
      ? { width: stage.clientWidth, height: stage.clientHeight }
      : { width: window.innerWidth, height: window.innerHeight };
  };

  const download = async () => {
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
      const saved = await window.spaceMedia?.saveFile(attachment.fileName, bytes);
      if (saved !== null && saved !== undefined) {
        setSavedFlash(true); // the click's only visible receipt (user report 2026-10-19)
        window.setTimeout(() => setSavedFlash(false), 2000);
      }
    } catch (error) {
      log.warn("lightbox", `download failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /** oak's "Copy to clipboard": the image lands in the system clipboard as PNG
   *  (Chromium's ClipboardItem wants image/png) — decoded through a canvas. */
  const copyToClipboard = async () => {
    const image = imageRef.current;
    if (image === null || imageSize === null || busy) {
      return;
    }
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = imageSize.width;
      canvas.height = imageSize.height;
      const context = canvas.getContext("2d");
      if (context === null) {
        return;
      }
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob === null || typeof ClipboardItem === "undefined") {
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
    } catch (error) {
      log.warn("lightbox", `copy failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /** The Details card toggles at the BUTTON (live report: it used to pin to the
   *  viewer's top-left and refused to close). The byte size rides the first
   *  open — the DTO carries none. */
  const toggleDetails = async (button: HTMLButtonElement) => {
    if (detailsAnchor !== null) {
      setDetailsAnchor(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setDetailsAnchor({ x: rect.left, y: rect.top });
    if (attachment === null || attachment.key === null || detailsByteSize !== null || busy) {
      return;
    }
    setBusy(true);
    try {
      const fresh = await session.rest.freshAttachmentLink(attachment.key);
      if (fresh === null) {
        return;
      }
      const bytes = new Uint8Array(await session.rest.downloadBytes(fresh));
      setDetailsByteSize(bytes.byteLength);
    } catch (error) {
      log.warn("lightbox", `details fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const zoomed = transform.scale > 1;
  const fileExtension = attachment !== null && attachment.fileName.includes(".")
    ? attachment.fileName.slice(attachment.fileName.lastIndexOf(".") + 1).toUpperCase()
    : "";

  // Click outside the window (the OS took focus elsewhere) closes the viewer
  // — the same contract useOutsideDismiss gives the popups (user rule
  // 2026-10-19: "close on a click outside the app window when possible").
  useEffect(() => {
    window.addEventListener("blur", onClose);
    return () => window.removeEventListener("blur", onClose);
  }, [onClose]);

  return createPortal(
    <div
      className="lightbox"
      ref={stageRef}
      onWheel={(event) => {
        event.preventDefault();
        if (imageSize === null) {
          return;
        }
        const stage = stageRef.current?.getBoundingClientRect();
        const cursorX = stage !== undefined ? event.clientX - stage.left : 0;
        const cursorY = stage !== undefined ? event.clientY - stage.top : 0;
        setTransform((current) => zoomAt(current, viewport(), imageSize.width, imageSize.height, cursorX, cursorY, event.deltaY));
      }}
      onMouseDown={(event) => {
        dragStateRef.current = { lastX: event.clientX, lastY: event.clientY };
        pressPointRef.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        // Backdrop click-to-close: only a press-and-release ON THE BACKDROP
        // itself (target === the root — the image and toolbar are children)
        // that never turned into a pan (a few px of jitter is still a click).
        if (event.target !== event.currentTarget) {
          return;
        }
        const press = pressPointRef.current;
        if (press !== null && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6) {
          onClose();
        }
        pressPointRef.current = null;
      }}
      onMouseMove={(event) => {
        const drag = dragStateRef.current;
        if (drag === null || imageSize === null) {
          return;
        }
        const deltaX = event.clientX - drag.lastX;
        const deltaY = event.clientY - drag.lastY;
        dragStateRef.current = { lastX: event.clientX, lastY: event.clientY };
        setTransform((current) => panTransform(current, viewport(), imageSize.width, imageSize.height, deltaX, deltaY));
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
          ref={imageRef}
          className="lightbox-image"
          src={url}
          alt={attachment?.fileName ?? ""}
          draggable={false}
          onLoad={(event) => {
            const element = event.currentTarget;
            const size = { width: element.naturalWidth, height: element.naturalHeight };
            setImageSize(size);
            setTransform(initialTransform(viewport(), size.width, size.height));
          }}
          style={imageSize !== null
            ? {
              position: "absolute",
              left: transform.offsetX,
              top: transform.offsetY,
              width: imageSize.width * transform.baseScale * transform.scale,
              height: imageSize.height * transform.baseScale * transform.scale,
              maxWidth: "none",
              cursor: zoomed ? "grab" : "default",
            }
            : undefined}
        />
      ) : (
        <div className="lightbox-status">loading…</div>
      )}
      {detailsAnchor !== null && attachment !== null ? (
        <div
          className="lightbox-details"
          style={{ left: detailsAnchor.x, bottom: window.innerHeight - detailsAnchor.y + 8 }}
        >
          <div><span>Name</span>{attachment.fileName}</div>
          <div><span>Type</span>{fileExtension}</div>
          {imageSize !== null ? <div><span>Dimensions</span>{imageSize.width} × {imageSize.height} px</div> : null}
          <div><span>Size</span>{detailsByteSize !== null ? humanByteSize(detailsByteSize) : "…"}</div>
        </div>
      ) : null}
      <div className="lightbox-toolbar">
        {images.length > 1 ? (
          <>
            <button className="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)} title="Previous">
              <span className="icon mdi-chevron-left" />
            </button>
            <span className="lightbox-counter">{index + 1} / {images.length}</span>
            <button className="ghost" disabled={index >= images.length - 1} onClick={() => setIndex(index + 1)} title="Next">
              <span className="icon mdi-chevron-right" />
            </button>
          </>
        ) : null}
        <button className="ghost" disabled={busy} onClick={() => void download()} title="Download">
          <span className={"icon " + (savedFlash ? "mdi-check" : busy ? "mdi-refresh sp-spin" : "mdi-download")} />
        </button>
        {onForwardBegin !== undefined ? (
          <button className="ghost" onClick={() => { onForwardBegin(); onClose(); }} title="Forward the image"><span className="icon mdi-forward" /></button>
        ) : null}
        <button
          className="ghost"
          onClick={() => attachment !== null && void window.spaceMedia?.openExternal(attachment.url)}
          title="Open in browser"
        >
          <span className="icon mdi-open-in-new" />
        </button>
        <button className="ghost" disabled={busy} onClick={() => void copyToClipboard()} title={copied ? "Copied" : "Copy to clipboard"}>
          <span className={"icon " + (copied ? "mdi-check" : "mdi-content-copy")} />
        </button>
        <button className="ghost" onClick={(event) => void toggleDetails(event.currentTarget)} title="Details"><span className="icon mdi-information-outline" /></button>
        <button className="ghost" onClick={onClose} title="Close"><span className="icon mdi-close" /></button>
      </div>
    </div>,
    document.body,
  );
}
