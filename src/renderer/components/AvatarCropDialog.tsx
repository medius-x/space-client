import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { log } from "../../logging";

/**
 * Interactive square crop (move + corner resize) over a chosen image. On Apply
 * the selected square is rendered into an offscreen canvas at 256×256 → PNG blob.
 * Coordinates live in DISPLAY space and are mapped back through the display
 * scale — the source may be far larger than the dialog.
 */
const BOX = 380;
const MIN_CROP = 48;

export function AvatarCropDialog({ imageSourceUrl, onApply, onClose }: {
  imageSourceUrl: string;
  onApply(blob: Blob): void;
  onClose(): void;
}): React.JSX.Element {
  const [imageSize, setImageSize] = useState({ width: BOX, height: BOX });
  const [crop, setCrop] = useState({ x: 40, y: 40, size: 160 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; base: { x: number; y: number; size: number } } | null>(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(BOX / image.naturalWidth, BOX / image.naturalHeight, 1);
      const width = Math.round(image.naturalWidth * scale);
      const height = Math.round(image.naturalHeight * scale);
      setImageSize({ width, height });
      const initialSize = Math.min(width, height, 220);
      setCrop({ x: Math.round((width - initialSize) / 2), y: Math.round((height - initialSize) / 2), size: initialSize });
    };
    image.addEventListener("error", () => {
      log.error("avatar", `crop source failed to load: ${imageSourceUrl.slice(0, 120)}`);
    });
    image.src = imageSourceUrl;
    imageRef.current = image;
  }, [imageSourceUrl]);

  const onPointerDown = (mode: "move" | "resize") => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, base: { ...crop } };
  };
  const onPointerMove = (event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (drag.mode === "move") {
      setCrop({
        ...drag.base,
        x: Math.min(imageSize.width - drag.base.size, Math.max(0, drag.base.x + deltaX)),
        y: Math.min(imageSize.height - drag.base.size, Math.max(0, drag.base.y + deltaY)),
      });
      return;
    }
    const size = Math.min(
      imageSize.width - drag.base.x,
      imageSize.height - drag.base.y,
      Math.max(MIN_CROP, drag.base.size + deltaX),
    );
    setCrop({ ...drag.base, size });
  };

  const apply = () => {
    const image = imageRef.current;
    if (image === null) {
      return;
    }
    const displayScale = imageSize.width / image.naturalWidth;
    const sourceX = crop.x / displayScale;
    const sourceY = crop.y / displayScale;
    const sourceSize = crop.size / displayScale;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 256, 256);
    canvas.toBlob((blob) => {
      if (blob !== null) {
        onApply(blob);
      }
    }, "image/png");
  };

  return (
    <Modal title="Crop avatar" onClose={onClose}>
      <div
        className="crop-stage"
        style={{ width: imageSize.width, height: imageSize.height }}
        onMouseMove={onPointerMove}
        onMouseUp={() => { dragRef.current = null; }}
        onMouseLeave={() => { dragRef.current = null; }}
      >
        <img
          src={imageSourceUrl}
          alt="source"
          draggable={false}
          onError={() => log.error("avatar", `crop <img> error event: ${imageSourceUrl.slice(0, 120)}`)}
        />
        <div
          className="crop-square"
          style={{ left: crop.x, top: crop.y, width: crop.size, height: crop.size }}
          onMouseDown={onPointerDown("move")}
        >
          <span className="crop-handle" onMouseDown={onPointerDown("resize")} />
        </div>
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={apply}>Apply</button>
      </div>
    </Modal>
  );
}
