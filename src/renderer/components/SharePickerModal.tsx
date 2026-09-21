import { useEffect, useRef, useState } from "react";
import type { CaptureSourceInfo } from "../bridges";
import type { ShareTarget } from "../runtime";
import { Modal } from "./Modal";

type PickerTab = "screen" | "window" | "camera";

interface CameraEntry {
  deviceId: string;
  label: string;
}

/**
 * The Discord-style share picker (M4 + #485): desktop sources WITH preview
 * thumbnails (enumerated by the main process) — screens carry native system
 * audio (desktop minus this client), windows carry that application's own
 * audio when the native per-app capture is available (otherwise video-only,
 * the M4 behavior) — and the cameras as a list with ONE live preview (the
 * selected camera, falling back to the first — holding every device open at
 * once is what v1 avoided, a single preview stream keeps one camera lit). The
 * preview is stopped before the real capture so Share takes over the device
 * cleanly.
 */
export function SharePickerModal({ onTarget, onClose }: {
  onTarget(target: ShareTarget): void;
  onClose(): void;
}): React.JSX.Element {
  const [tab, setTab] = useState<PickerTab>("screen");
  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether window shares can carry per-app audio (#485 native capture) — the
  // Windows-tab hint must not promise audio the platform cannot deliver.
  const [nativeWindowAudio, setNativeWindowAudio] = useState(false);

  // The camera tab's live preview: ONE stream for the camera being looked at.
  const previewStreamRef = useRef<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const stopPreview = (): void => {
    const stream = previewStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    previewStreamRef.current = null;
    setPreviewStream(null);
  };

  useEffect(() => {
    let cancelled = false;
    void window.spaceSysAudio?.available().then((ok) => {
      if (!cancelled && ok === true) {
        setNativeWindowAudio(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSourcesLoading(true);
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
      } finally {
        if (!cancelled) {
          setSourcesLoading(false);
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
    setCamerasLoading(true);
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (cancelled) {
        return;
      }
      setCameras(devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })));
      setCamerasLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setCamerasLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // The previewed camera: the explicit selection, or the first one so the tab
  // opens with a live picture. The Share button still needs an explicit pick.
  const previewDeviceId = tab === "camera"
    ? selected ?? cameras[0]?.deviceId ?? null
    : null;
  useEffect(() => {
    setPreviewFailed(false);
    if (previewDeviceId === null) {
      stopPreview();
      return;
    }
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: previewDeviceId }, width: { ideal: 640 }, height: { ideal: 360 } },
      audio: false,
    }).then((stream) => {
      if (cancelled) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      stopPreview(); // the PREVIOUS camera's stream, if any
      previewStreamRef.current = stream;
      setPreviewStream(stream);
    }).catch(() => {
      if (!cancelled) {
        setPreviewFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [previewDeviceId]);

  // Leaving the modal (share, cancel, Escape) must release the camera.
  useEffect(() => () => stopPreview(), []);

  const tabSources = sources.filter((source) => source.kind === tab);
  const share = (): void => {
    if (selected === null) {
      return;
    }
    if (tab === "camera") {
      stopPreview(); // hand the device over to the real capture
    }
    onTarget({ kind: tab, id: selected });
  };

  return (
    <Modal title="Share your screen" onClose={onClose}>
      <div className="modal-row picker-tabs">
        <button className={"kind-choice" + (tab === "screen" ? " chosen" : "")} onClick={() => { setTab("screen"); setSelected(null); }}><span className="icon mdi-monitor" /> Screens</button>
        <button className={"kind-choice" + (tab === "window" ? " chosen" : "")} onClick={() => { setTab("window"); setSelected(null); }}><span className="icon mdi-application" /> Windows</button>
        <button className={"kind-choice" + (tab === "camera" ? " chosen" : "")} onClick={() => { setTab("camera"); setSelected(null); }}><span className="icon mdi-video" /> Camera</button>
      </div>
      <div className="error-line">{error ?? ""}</div>
      {tab === "camera" ? (
        <>
          {cameras.length > 0 ? (
            <div className="picker-camera-preview">
              {previewStream !== null ? (
                <CameraPreviewVideo stream={previewStream} />
              ) : previewFailed ? (
                <span className="picker-preview-note">Camera preview unavailable</span>
              ) : (
                <span className="picker-loading"><span className="icon mdi-refresh" /></span>
              )}
            </div>
          ) : null}
          <div className="picker-list">
            {camerasLoading ? <div className="picker-loading"><span className="icon mdi-refresh" /> Looking for cameras…</div> : null}
            {!camerasLoading && cameras.length === 0 ? <div className="modal-note">No cameras found.</div> : null}
            {cameras.map((camera) => (
              <div
                key={camera.deviceId}
                className={"picker-row" + (selected === camera.deviceId ? " chosen" : "")}
                onClick={() => setSelected(camera.deviceId)}
              >
                <span className="icon mdi-video" /> {camera.label}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="picker-grid">
          {sourcesLoading ? <div className="picker-loading"><span className="icon mdi-refresh" /> Looking for {tab === "screen" ? "screens" : "windows"}…</div> : null}
          {!sourcesLoading && error === null && tabSources.length === 0 ? <div className="modal-note">No {tab === "screen" ? "screens" : "windows"} found.</div> : null}
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
                  : <span className="picker-thumb-placeholder">{source.kind === "screen" ? <span className="icon mdi-monitor" /> : <span className="icon mdi-application" />}</span>}
              </div>
              <div className="picker-name">{source.name}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "screen" ? <div className="modal-note">Whole-screen shares include system audio (stereo) minus this client's own sounds.</div> : null}
      {tab === "window" ? (
        <div className="modal-note">
          {nativeWindowAudio
            ? "Window shares carry only that application's audio (native per-app capture)."
            : "Window shares have no audio — system loopback captures the whole desktop, and the native per-app capture is unavailable here."}
        </div>
      ) : null}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={selected === null} onClick={share}>Share</button>
      </div>
    </Modal>
  );
}

/** Binds one captured stream to a muted <video> (autoplay needs muted). */
function CameraPreviewVideo({ stream }: { stream: MediaStream }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) {
      return;
    }
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={videoRef} muted playsInline />;
}
