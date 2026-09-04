/**
 * Client-side video preview generation (the server never runs ffmpeg): seek a
 * muted off-DOM <video> to ~5%, draw the frame into a canvas capped at 480px,
 * re-encode as JPEG. ANY failure (exotic codec, no frame in time) resolves null
 * — the message then simply sends without a preview, never blocking the send.
 */

const GRAB_TIMEOUT_MS = 5_000;
const MAX_SIDE = 480;

export interface VideoPreview {
  jpegBlob: Blob;
  durationMillis: number;
}

export function generateVideoPreview(file: File): Promise<VideoPreview | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (result: VideoPreview | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      video.removeAttribute("src");
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => finish(null), GRAB_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", () => {
      const durationSeconds = video.duration;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        finish(null);
        return;
      }
      video.currentTime = durationSeconds * 0.05;
    });

    video.addEventListener("seeked", () => {
      try {
        const naturalWidth = video.videoWidth;
        const naturalHeight = video.videoHeight;
        if (naturalWidth <= 0 || naturalHeight <= 0) {
          finish(null);
          return;
        }
        const scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (context === null) {
          finish(null);
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          finish(blob === null ? null : { jpegBlob: blob, durationMillis: Math.round(video.duration * 1000) });
        }, "image/jpeg", 0.8);
      } catch {
        finish(null);
      }
    });

    video.addEventListener("error", () => finish(null));
    video.src = objectUrl;
  });
}
