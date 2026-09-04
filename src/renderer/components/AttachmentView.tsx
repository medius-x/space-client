import { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { computeMosaicTiles, isAudioFile, isImageFile, isVideoFile } from "../../domain/logic/attachment-layout";
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

/**
 * Everything a message carries besides text: the image mosaic, video cards
 * (client-generated preview + play overlay + duration badge), audio cards
 * (one shared player) and plain file chips (system browser fallback).
 */
export function AttachmentView({ session, message }: {
  session: ConnectionSession;
  message: Message;
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
  const tiles = computeMosaicTiles(Math.min(images.length, 10), containerWidth);
  const multiColumn = images.length >= 4;

  return (
    <div className="attachment-block" ref={containerRef}>
      {images.length > 0 ? (
        <div className={multiColumn ? "mosaic-grid" : "mosaic-row"} style={multiColumn ? undefined : { gap: 8 }}>
          {images.slice(0, 10).map((attachment, index) => (
            <MosaicTileView
              key={attachment.key}
              session={session}
              attachment={attachment}
              tile={tiles[index] ?? { width: 200, height: 140 }}
              onClick={() => setLightbox({ images: images.slice(0, 10), index })}
            />
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
          📄 {attachment.fileName}
        </button>
      ))}
      {video !== null ? <VideoModal session={session} attachment={video} onClose={() => setVideo(null)} /> : null}
      {lightbox !== null ? (
        <Lightbox session={session} images={lightbox.images} startIndex={lightbox.index} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

function MosaicTileView({ session, attachment, tile, onClick }: {
  session: ConnectionSession;
  attachment: Attachment;
  tile: { width: number; height: number };
  onClick(): void;
}): React.JSX.Element {
  const url = useAttachmentImage(session, attachment.key !== null && attachment.url !== null ? { key: attachment.key, url: attachment.url } : null);
  return (
    <div className="mosaic-tile" style={{ width: tile.width, height: tile.height }} onClick={onClick} title={attachment.fileName}>
      {url !== null ? <img src={url} alt={attachment.fileName} draggable={false} /> : <div className="mosaic-loading" />}
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
      <div className="video-thumb">
        {thumbUrl !== null ? <img src={thumbUrl} alt={attachment.fileName} draggable={false} /> : <span className="video-thumb-glyph">🎬</span>}
        <span className="video-play-overlay">▶</span>
        {durationSeconds !== null ? <span className="video-duration-badge">{formatClock(durationSeconds)}</span> : null}
      </div>
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
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <div className="audio-card">
      <button className="audio-play" onClick={() => void session.playback.play(attachment.key, attachment.fileName, attachment.url)}>
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="audio-body">
        <div className="file-name">{attachment.fileName}</div>
        <input
          type="range" min={0} max={Math.max(0.1, duration)} step={0.1}
          value={position}
          onChange={(event) => session.playback.seek(event.currentTarget.valueAsNumber)}
        />
        <div className="audio-time">{formatClock(position)} / {formatClock(duration)}</div>
      </div>
    </div>
  );
}
