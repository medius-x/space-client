import { useRef, useState, type ReactNode } from "react";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { AttachmentUploadSlot } from "../../types";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { Modal } from "./Modal";

const ORIGINAL_MAX_SIDE = 2048;

/** The upload endpoints behind an avatar editor — the user avatar and the server
 *  icon share the exact two-phase flow, only the routes differ. */
export interface AvatarApi {
  requestSlot(fileName: string): Promise<AttachmentUploadSlot>;
  requestOriginalSlot(fileName: string): Promise<AttachmentUploadSlot>;
  confirm(avatarKey: string, originalKey: string | null): Promise<unknown>;
  remove(): Promise<unknown>;
  /** Presigned GET of the stored pre-crop original; null when none exists. */
  originalUrl(): Promise<string | null>;
}

/** The user-avatar routes (Settings → General). */
export function userAvatarApi(session: ConnectionSession): AvatarApi {
  return {
    requestSlot: (fileName) => session.rest.requestAvatarUpload(fileName),
    requestOriginalSlot: (fileName) => session.rest.requestAvatarOriginalUpload(fileName),
    confirm: (avatarKey, originalKey) => session.rest.confirmAvatar(avatarKey, originalKey),
    remove: () => session.rest.removeAvatar(),
    originalUrl: () => session.rest.getAvatarOriginalUrl(),
  };
}

/** The server-icon routes (Server Settings → Overview, MANAGE_SERVER). */
export function serverAvatarApi(session: ConnectionSession): AvatarApi {
  return {
    requestSlot: (fileName) => session.rest.requestServerAvatarUpload(fileName),
    requestOriginalSlot: (fileName) => session.rest.requestServerAvatarOriginalUpload(fileName),
    confirm: (avatarKey, originalKey) => session.rest.confirmServerAvatar(avatarKey, originalKey),
    remove: () => session.rest.removeServerAvatar(),
    originalUrl: () => session.rest.getServerAvatarOriginalUrl(),
  };
}

/** Two-phase avatar upload: original (≤2048, kept server-side for re-crops) + the 256 crop. */
async function downscaleToPngBlob(file: File, maxSide: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d context unavailable");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("encode failed")) : resolve(blob)), "image/png");
  });
}

/**
 * The avatar editor (oak's Settings → General): two-phase upload with an
 * interactive crop, re-crop from the stored original, remove. The PREVIEW (a
 * user's round avatar vs the server's squircle icon) is passed in.
 */
export function AvatarEditor({ session, api, preview, hint, removeTitle, removeNote, stacked = false }: {
  session: ConnectionSession;
  api: AvatarApi;
  preview: ReactNode;
  hint?: string;
  /** The confirm dialog's wording — oak confirms destructive icon/avatar removal. */
  removeTitle: string;
  removeNote: string;
  /** Overview layout: the preview on the left, the buttons stacked beside it. */
  stacked?: boolean;
}): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [sourceOwned, setSourceOwned] = useState(false); // blob: URLs we must revoke
  const [cropFromFile, setCropFromFile] = useState<File | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = () => {
    fileInputRef.current?.click();
  };

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file === null) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("Pick a PNG or JPG image.");
      return;
    }
    setCropFromFile(file);
    setCropSourceUrl(URL.createObjectURL(file));
    setSourceOwned(true);
  };

  const closeCrop = () => {
    if (sourceOwned && cropSourceUrl !== null && cropSourceUrl.startsWith("blob:")) {
      URL.revokeObjectURL(cropSourceUrl);
    }
    setCropSourceUrl(null);
    setCropFromFile(null);
    setSourceOwned(false);
  };

  const applyCrop = async (croppedBlob: Blob) => {
    const sourceFile = cropFromFile;
    closeCrop();
    setBusy(true);
    setError(null);
    try {
      // 1) the original (downscaled, kept for future re-crops). Fixed ASCII name —
      // the slot endpoint 400s on non-ASCII and the key doesn't need the user's name.
      const originalBlob = sourceFile !== null ? await downscaleToPngBlob(sourceFile, ORIGINAL_MAX_SIDE) : null;
      let originalKey: string | null = null;
      if (originalBlob !== null && sourceFile !== null) {
        const originalSlot = await api.requestOriginalSlot("avatar-original.png");
        await session.rest.uploadBytes(originalSlot.uploadUrl, await originalBlob.arrayBuffer(), "image/png");
        originalKey = originalSlot.key;
      }
      // 2) the 256 crop
      const avatarSlot = await api.requestSlot("avatar.png");
      await session.rest.uploadBytes(avatarSlot.uploadUrl, await croppedBlob.arrayBuffer(), "image/png");
      // 3) confirm — the push (/topic/users or /topic/server) refreshes everyone
      await api.confirm(avatarSlot.key, originalKey);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setBusy(false);
    }
  };

  const beginRecrop = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await api.originalUrl();
      if (url === null) {
        setError("No stored original — pick a new image instead.");
        return;
      }
      // Route through the attachment cache (fetch → blob URL): the same pipeline
      // every other image uses. A raw presigned URL in <img> proved flaky, and a
      // blob: source also keeps the crop canvas untainted.
      // The cache key is the OBJECT PATH from the presigned URL, never a constant:
      // a constant key ("avatar-original") made the cache serve the PREVIOUS
      // avatar's original after a change — re-crop opened the wrong image (live
      // report). The path is stable across re-signatures and distinct per upload.
      const objectPath = new URL(url).pathname;
      const objectUrl = await session.attachmentCache.loadImage({ key: `avatar-original:${objectPath}`, url });
      if (objectUrl === null) {
        setError("Could not load the stored original.");
        return;
      }
      setCropFromFile(null);
      setSourceOwned(false);
      setCropSourceUrl(objectUrl);
    } catch (recropError) {
      setError(recropError instanceof Error ? recropError.message : String(recropError));
    } finally {
      setBusy(false);
    }
  };

  const removeCurrent = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.remove();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setBusy(false);
      setRemoveArmed(false);
    }
  };

  return (
    <div>
      <div className={"avatar-editor-block" + (stacked ? " stacked" : "")}>
        <div className="profile-head">
          {preview}
          {busy ? <div className="settings-hint">Working…</div> : null}
        </div>
        <div className="modal-actions left profile-actions">
          <button className="primary" disabled={busy} onClick={pickFile}>Change avatar…</button>
          <button className="ghost" disabled={busy} onClick={() => void beginRecrop()}>Re-crop</button>
          <button className="danger" disabled={busy} onClick={() => setRemoveArmed(true)}>Remove</button>
        </div>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChosen} />
      <div className="error-line">{error ?? ""}</div>
      {removeArmed ? (
        <Modal title={removeTitle} onClose={() => setRemoveArmed(false)}>
          <div className="modal-note">{removeNote}</div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setRemoveArmed(false)}>Cancel</button>
            <button className="danger" disabled={busy} onClick={() => void removeCurrent()}>Remove</button>
          </div>
        </Modal>
      ) : null}
      {cropSourceUrl !== null ? (
        <AvatarCropDialog imageSourceUrl={cropSourceUrl} onApply={(blob) => void applyCrop(blob)} onClose={closeCrop} />
      ) : null}
      {hint !== undefined ? <div className="settings-hint">{hint}</div> : null}
    </div>
  );
}
