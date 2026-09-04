import { useEffect, useState } from "react";
import type { CaptureSourceInfo } from "../bridges";
import type { ShareTarget } from "../runtime";
import { Modal } from "./Modal";

type PickerTab = "screen" | "window" | "camera";

interface CameraEntry {
  deviceId: string;
  label: string;
}

/**
 * The Discord-style share picker (M4): desktop sources WITH preview thumbnails
 * (enumerated by the main process), windows without audio (system loopback exists
 * only for whole screens), and the cameras as a plain list (a live preview per
 * camera would hold every device open — v1 keeps one camera usable at a time).
 */
export function SharePickerModal({ onTarget, onClose }: {
  onTarget(target: ShareTarget): void;
  onClose(): void;
}): React.JSX.Element {
  const [tab, setTab] = useState<PickerTab>("screen");
  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await window.spaceCapture?.sources();
        if (!cancelled) {
          setSources(Array.isArray(listed) ? (listed as CaptureSourceInfo[]) : []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tab !== "camera") {
      return;
    }
    let cancelled = false;
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (cancelled) {
        return;
      }
      setCameras(devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const tabSources = sources.filter((source) => source.kind === tab);
  const share = (): void => {
    if (selected === null) {
      return;
    }
    onTarget({ kind: tab, id: selected });
  };

  return (
    <Modal title="Share your screen" onClose={onClose}>
      <div className="modal-row picker-tabs">
        <button className={"kind-choice" + (tab === "screen" ? " chosen" : "")} onClick={() => { setTab("screen"); setSelected(null); }}><span className="icon mdi-monitor" style={{ fontSize: 16 }} /> Screens</button>
        <button className={"kind-choice" + (tab === "window" ? " chosen" : "")} onClick={() => { setTab("window"); setSelected(null); }}><span className="icon mdi-application" style={{ fontSize: 16 }} /> Windows</button>
        <button className={"kind-choice" + (tab === "camera" ? " chosen" : "")} onClick={() => { setTab("camera"); setSelected(null); }}><span className="icon mdi-video" style={{ fontSize: 16 }} /> Camera</button>
      </div>
      <div className="error-line">{error ?? ""}</div>
      {tab === "camera" ? (
        <div className="picker-list">
          {cameras.length === 0 ? <div className="modal-note">No cameras found.</div> : null}
          {cameras.map((camera) => (
            <div
              key={camera.deviceId}
              className={"picker-row" + (selected === camera.deviceId ? " chosen" : "")}
              onClick={() => setSelected(camera.deviceId)}
            >
              <span className="icon mdi-video" style={{ fontSize: 16 }} /> {camera.label}
            </div>
          ))}
        </div>
      ) : (
        <div className="picker-grid">
          {tabSources.length === 0 ? <div className="modal-note">No {tab === "screen" ? "screens" : "windows"} found.</div> : null}
          {tabSources.map((source) => (
            <div
              key={source.id}
              className={"picker-tile" + (selected === source.id ? " chosen" : "")}
              title={source.name}
              onClick={() => setSelected(source.id)}
            >
              <div className="picker-thumb">
                {source.thumbnailDataUrl !== null
                  ? <img src={source.thumbnailDataUrl} alt={source.name} draggable={false} />
                  : <span className="picker-thumb-placeholder">{source.kind === "screen" ? <span className="icon mdi-monitor" style={{ fontSize: 24 }} /> : <span className="icon mdi-application" style={{ fontSize: 24 }} />}</span>}
              </div>
              <div className="picker-name">{source.name}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "screen" ? <div className="modal-note">Whole-screen shares include system audio (stereo).</div> : null}
      {tab === "window" ? <div className="modal-note">Window shares have no audio — system loopback captures the whole desktop.</div> : null}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={selected === null} onClick={share}>Share</button>
      </div>
    </Modal>
  );
}
