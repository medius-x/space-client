import { useRef, useState } from "react";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { Avatar } from "./Avatar";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { Modal } from "./Modal";

const ORIGINAL_MAX_SIDE = 2048;

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

export function ProfileModal({ session, onClose }: {
  session: ConnectionSession;
  onClose(): void;
}): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [sourceOwned, setSourceOwned] = useState(false); // blob: URLs we must revoke
  const [cropFromFile, setCropFromFile] = useState<File | null>(null);
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
        const originalSlot = await session.rest.requestAvatarOriginalUpload("avatar-original.png");
        await session.rest.uploadBytes(originalSlot.uploadUrl, await originalBlob.arrayBuffer(), "image/png");
        originalKey = originalSlot.key;
      }
      // 2) the 256 crop
      const avatarSlot = await session.rest.requestAvatarUpload("avatar.png");
      await session.rest.uploadBytes(avatarSlot.uploadUrl, await croppedBlob.arrayBuffer(), "image/png");
      // 3) confirm — /topic/users pushes the fresh avatar to everyone
      await session.rest.confirmAvatar(avatarSlot.key, originalKey);
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
      const url = await session.rest.getAvatarOriginalUrl();
      if (url === null) {
        setError("No stored original — pick a new image instead.");
        return;
      }
      // Route through the attachment cache (fetch → blob URL): the same pipeline
      // every other image uses. A raw presigned URL in <img> proved flaky, and a
      // blob: source also keeps the crop canvas untainted.
      const objectUrl = await session.attachmentCache.loadImage({ key: "avatar-original", url });
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
      await session.rest.removeAvatar();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Profile" onClose={onClose}>
      <div className="profile-head">
        <Avatar session={session} username={session.username()} size={72} />
        <div className="profile-name">{session.username()}</div>
      </div>
      <div className="modal-actions profile-actions">
        <button className="primary" disabled={busy} onClick={pickFile}>Change avatar…</button>
        <button className="ghost" disabled={busy} onClick={() => void beginRecrop()}>Re-crop</button>
        <button className="danger" disabled={busy} onClick={() => void removeCurrent()}>Remove</button>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChosen} />
      <div className="error-line">{error ?? ""}</div>
      {cropSourceUrl !== null ? (
        <AvatarCropDialog imageSourceUrl={cropSourceUrl} onApply={(blob) => void applyCrop(blob)} onClose={closeCrop} />
      ) : null}
      {busy ? <div className="modal-note">Working…</div> : null}
      <div className="modal-note">The avatar updates live for everyone.</div>
    </Modal>
  );
}
