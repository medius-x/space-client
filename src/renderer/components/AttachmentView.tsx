import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import type { ConnectionSession } from "../../domain/session/connection-session";
import {
  computeMosaicTiles,
  isAudioFile,
  isImageFile,
  isVideoFile,
  singleTileBox,
} from "../../domain/logic/attachment-layout";
import type { Attachment, Message } from "../../types";
import { Lightbox } from "./Lightbox";
import { VideoModal } from "./VideoModal";

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function openExternal(url: string): Promise<void> {
  await window.spaceMedia?.openExternal(url);
}

/** The edit-mode image removal (oak's attachmentRemovalActive): each image tile
 *  grows an "×" and dims when marked; the commit PATCHes the remaining keys. */
export interface AttachmentRemoval {
  markedKeys: ReadonlySet<string>;
  toggle(key: string): void;
}

/**
 * Everything a message carries besides text: the image mosaic, video cards
 * (client-generated preview + play overlay + duration badge), audio cards
 * (one shared player) and plain file chips (system browser fallback).
 * oak's mosaic math: 1 image = a square bounded by the row width AND its own
 * smaller natural side (no upscale); 2–3 = one row of square crops; 4+ = a
 * 2-column grid of square crops; the gap is oak's 4.
 */
export function AttachmentView({ session, message, onForwardBegin, removal }: {
  session: ConnectionSession;
  message: Message;
  /** "Forward" in the lightbox opens the message's forward flow (ChatPane). */
  onForwardBegin?: () => void;
  /** Present while the message is being edited — image tiles become removable. */
  removal?: AttachmentRemoval;
}): React.JSX.Element | null {
  const attachments = message.attachments;
  const [lightbox, setLightbox] = useState<{ images: Attachment[]; index: number } | null>(null);
  const [video, setVideo] = useState<Attachment | null>(null);

  const images = attachments.filter((attachment) => isImageFile(attachment.fileName));
  const videos = attachments.filter((attachment) => isVideoFile(attachment.fileName));
  const audios = attachments.filter((attachment) => isAudioFile(attachment.fileName));
  const plainFiles = attachments.filter((attachment) =>
    !isImageFile(attachment.fileName) && !isVideoFile(attachment.fileName) && !isAudioFile(attachment.fileName));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(400);
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth));
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  if (attachments.length === 0) {
    return null;
  }
  const usable = Math.max(120, Math.floor(containerWidth));
  const shownImages = images.slice(0, 10);
  const tiles = computeMosaicTiles(shownImages.length, containerWidth);
  const multiColumn = shownImages.length >= 4;

  return (
    <div className="attachment-block" ref={containerRef}>
      {shownImages.length > 0 ? (
        <div className={multiColumn ? "mosaic-grid" : "mosaic-row"} style={multiColumn ? undefined : { gap: 4 }}>
          {shownImages.map((attachment, index) => (
            index === 0 && shownImages.length === 1 ? (
              <SingleTileView
                key={attachment.key}
                session={session}
                attachment={attachment}
                usableWidth={usable}
                removal={removal}
                onClick={() => setLightbox({ images: shownImages, index })}
              />
            ) : (
              <MosaicTileView
                key={attachment.key}
                session={session}
                attachment={attachment}
                tile={tiles[index] ?? { width: 200, height: 200 }}
                removal={removal}
                onClick={() => setLightbox({ images: shownImages, index })}
              />
            )
          ))}
        </div>
      ) : null}
      {videos.map((attachment) => (
        <VideoCardView key={attachment.key} session={session} attachment={attachment} onOpen={() => setVideo(attachment)} />
      ))}
      {audios.map((attachment) => (
        <AudioCardView key={attachment.key} session={session} attachment={attachment} />
      ))}
      {plainFiles.map((attachment) => (
        <button key={attachment.key} className="file-chip" onClick={() => void openExternal(attachment.url)}>
          <span className="icon mdi-attachment" /> {attachment.fileName}
        </button>
      ))}
      {video !== null ? <VideoModal session={session} attachment={video} onClose={() => setVideo(null)} /> : null}
      {lightbox !== null ? (
        <Lightbox
          session={session}
          images={lightbox.images}
          startIndex={lightbox.index}
          onForwardBegin={onForwardBegin}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

/** oak's tile "×" (attachment-remove-button, 16×16): only in edit mode, only on
 *  images; a marked tile dims to 0.4 — the commit sends the remaining keys.
 *  onMouseDown PREVENTS THE FOCUS MOVE: the editor commits on blur, and blur
 *  fires BEFORE click — without this the editor closed instead of marking. */
function TileRemoveButton({ attachment, removal }: {
  attachment: Attachment;
  removal: AttachmentRemoval | undefined;
}): React.JSX.Element | null {
  if (removal === undefined) {
    return null;
  }
  const marked = removal.markedKeys.has(attachment.key);
  return (
    <button
      className={"attachment-remove-button" + (marked ? " marked" : "")}
      title={marked ? "Keep image" : "Remove image"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        removal.toggle(attachment.key);
      }}
    >
      <span className="icon mdi-close" />
    </button>
  );
}

/** The SINGLE image: bounded by the row width and its OWN smaller natural side
 *  — never upscaled (64×64 stays 64×64) — and the box HUGS the image's aspect
 *  ratio: no letterbox bars (user decision; oak keeps the square bounding box,
 *  and the black padding read as broken rendering). Until the decode lands the
 *  placeholder is the full usable-width square (oak's rule). */
function SingleTileView({ session, attachment, usableWidth, removal, onClick }: {
  session: ConnectionSession;
  attachment: Attachment;
  usableWidth: number;
  removal?: AttachmentRemoval;
  onClick(): void;
}): React.JSX.Element {
  const url = useAttachmentImage(session, attachment.key !== null && attachment.url !== null ? { key: attachment.key, url: attachment.url } : null);
  const [box, setBox] = useState(() => singleTileBox(usableWidth, 0, 0));
  const marked = removal?.markedKeys.has(attachment.key) ?? false;
  return (
    <div
      className={"mosaic-tile single" + (marked ? " removal-marked" : "")}
      style={{ width: box.width, height: box.height }}
      onClick={removal === undefined ? onClick : undefined}
      title={attachment.fileName}
    >
      {url !== null ? (
        <img
          src={url}
          alt={attachment.fileName}
          draggable={false}
          onLoad={(event) =>
            setBox(singleTileBox(usableWidth, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))}
        />
      ) : (
        <div className="mosaic-loading" />
      )}
      <TileRemoveButton attachment={attachment} removal={removal} />
    </div>
  );
}

function MosaicTileView({ session, attachment, tile, removal, onClick }: {
  session: ConnectionSession;
  attachment: Attachment;
  tile: { width: number; height: number };
  removal?: AttachmentRemoval;
  onClick(): void;
}): React.JSX.Element {
  const url = useAttachmentImage(session, attachment.key !== null && attachment.url !== null ? { key: attachment.key, url: attachment.url } : null);
  const marked = removal?.markedKeys.has(attachment.key) ?? false;
  return (
    <div
      className={"mosaic-tile" + (marked ? " removal-marked" : "")}
      style={{ width: tile.width, height: tile.height }}
      onClick={removal === undefined ? onClick : undefined}
      title={attachment.fileName}
    >
      {url !== null ? <img src={url} alt={attachment.fileName} draggable={false} /> : <div className="mosaic-loading" />}
      <TileRemoveButton attachment={attachment} removal={removal} />
    </div>
  );
}

function VideoCardView({ session, attachment, onOpen }: {
  session: ConnectionSession;
  attachment: Attachment;
  onOpen(): void;
}): React.JSX.Element {
  const thumbUrl = useAttachmentImage(
    session,
    attachment.thumbnailKey !== null && attachment.thumbnailUrl !== null
      ? { key: attachment.thumbnailKey, url: attachment.thumbnailUrl }
      : null,
  );
  const durationSeconds = attachment.durationMillis !== null ? attachment.durationMillis / 1000 : null;
  return (
    <div className="video-card" onClick={onOpen} title={attachment.fileName}>
      {thumbUrl !== null ? (
        /* The thumb box HUGS the frame's own aspect ratio (vertical phone videos
           are narrow — a minimum width lefted a black bar on the right, live report). */
        <div className="video-thumb">
          <img src={thumbUrl} alt={attachment.fileName} draggable={false} />
          <span className="video-play-overlay">▶</span>
          {durationSeconds !== null ? <span className="video-duration-badge">{formatClock(durationSeconds)}</span> : null}
        </div>
      ) : (
        <div className="video-thumb video-thumb-fallback">
          <span className="video-thumb-glyph"><span className="icon mdi-file-video-outline" /></span>
          <span className="video-play-overlay">▶</span>
          {durationSeconds !== null ? <span className="video-duration-badge">{formatClock(durationSeconds)}</span> : null}
        </div>
      )}
      <div className="file-name">{attachment.fileName}</div>
    </div>
  );
}

function AudioCardView({ session, attachment }: {
  session: ConnectionSession;
  attachment: Attachment;
}): React.JSX.Element {
  const playbackState = useStore(session.playback, (state) => state);
  const isCurrent = playbackState.key === attachment.key;
  const position = isCurrent ? playbackState.positionSeconds : 0;
  const duration = isCurrent && playbackState.durationSeconds > 0
    ? playbackState.durationSeconds
    : attachment.durationMillis !== null ? attachment.durationMillis / 1000 : 0;
  const playing = isCurrent && playbackState.playing;
  const knownDuration = isCurrent ? playbackState.durationSeconds > 0 : duration > 0;

  return (
    <div className="audio-card">
      <button className="audio-play" onClick={() => void session.playback.play(attachment.key, attachment.fileName, attachment.url)}>
        <span className={"icon " + (playing ? "mdi-pause" : "mdi-play")} />
      </button>
      <div className="audio-body">
        <div className="file-name">{attachment.fileName}</div>
        <input
          type="range" min={0} max={knownDuration ? duration : 1} step={0.1}
          value={position}
          disabled={!knownDuration}
          onChange={(event) => session.playback.seek(event.currentTarget.valueAsNumber)}
        />
        <div className="audio-time">
          {knownDuration ? `${formatClock(position)} / ${formatClock(duration)}` : `${formatClock(position)} / --:--`}
        </div>
      </div>
    </div>
  );
}
