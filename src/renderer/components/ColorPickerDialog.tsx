import { useRef, useState } from "react";
import { hexToHsv, hsvToHex, type Hsv } from "../../domain/logic/color";
import { Modal } from "./Modal";

/**
 * oak's CustomColorDialog: a centered modal picker — an SV square over a hue
 * strip plus a HEX field. The web replacement for the native `<input type=color>`
 * popup (which Chromium anchors to a screen corner).
 */
export function ColorPickerDialog({ initialHex, onApply, onClose }: {
  initialHex: string;
  onApply(hex: string): void;
  onClose(): void;
}): React.JSX.Element {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initialHex));
  const [hexDraft, setHexDraft] = useState(initialHex.toLowerCase());
  const hueHex = hsvToHex({ hue: hsv.hue, saturation: 1, value: 1 });

  const commit = (next: Hsv): void => {
    setHsv(next);
    setHexDraft(hsvToHex(next));
  };

  // Pointer-drag math over either strip; pointer capture keeps the drag alive
  // when the cursor briefly leaves the element.
  const dragOver = (element: HTMLElement, clientX: number, clientY: number, axis: "sv" | "hue"): void => {
    const rect = element.getBoundingClientRect();
    const fractionX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fractionY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    if (axis === "hue") {
      commit({ ...hsv, hue: fractionX * 360 });
    } else {
      commit({ ...hsv, saturation: fractionX, value: 1 - fractionY });
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>, axis: "sv" | "hue") => {
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    dragOver(element, event.clientX, event.clientY, axis);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>, axis: "sv" | "hue") => {
    if (event.buttons === 0) {
      return;
    }
    dragOver(event.currentTarget, event.clientX, event.clientY, axis);
  };

  const applyHexDraft = (): void => {
    const parsed = hexToHsv(hexDraft);
    if (hexDraft.trim().match(/^#?[0-9a-f]{6}$/i) !== null) {
      setHsv(parsed);
    } else {
      setHexDraft(hsvToHex(hsv)); // reject the invalid draft — back to the picker
    }
  };

  return (
    <Modal title="Custom color" onClose={onClose}>
      <div
        className="picker-sv"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})`,
        }}
        onPointerDown={(event) => startDrag(event, "sv")}
        onPointerMove={(event) => moveDrag(event, "sv")}
      >
        <span
          className="picker-marker"
          style={{
            left: `${hsv.saturation * 100}%`,
            top: `${(1 - hsv.value) * 100}%`,
            background: hsvToHex(hsv),
          }}
        />
      </div>
      <div
        className="picker-hue"
        onPointerDown={(event) => startDrag(event, "hue")}
        onPointerMove={(event) => moveDrag(event, "hue")}
      >
        <span className="picker-marker" style={{ left: `${(hsv.hue / 360) * 100}%`, background: hueHex }} />
      </div>
      <div className="picker-hex-row">
        <span className="picker-preview" style={{ background: hsvToHex(hsv) }} />
        <input
          type="text"
          value={hexDraft}
          onChange={(event) => setHexDraft(event.target.value)}
          onBlur={applyHexDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyHexDraft();
            }
          }}
        />
      </div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => {
          applyHexDraft();
          onApply(hsvToHex(hsv));
          onClose();
        }}>Apply</button>
      </div>
    </Modal>
  );
}
