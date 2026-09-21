import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureSourceInfo } from "../bridges";
import type { ShareTarget } from "../runtime";
import { settingsStore } from "../runtime";
import { useStore } from "../hooks/useStore";
import {
  BUILTIN_PRESETS,
  BITRATE_CHOICES_MBPS,
  DEFAULT_PICKER_QUALITY,
  FPS_CHOICES,
  clampQualityToSource,
  describeQuality,
  feasibleResolutions,
  formatBitrate,
  presetLabel,
  resolveQuality,
  upsertPreset,
  type ResolutionChoice,
  type SavedSharePreset,
  type ShareQuality,
} from "../../domain/logic/share-quality";
import { Modal } from "./Modal";

type PickerTab = "screen" | "window" | "camera";

interface CameraEntry {
  deviceId: string;
  label: string;
}

/**
 * The Discord-style share picker (M4 + #485), now two-step like oak's
 * ScreenSourcePicker: step one picks the source (desktop sources WITH preview
 * thumbnails, cameras with ONE live preview), step two is QUALITY — a preset
 * combo, the frame-rate/resolution/bitrate segment rows, a save-preset row and
 * the per-kind audio checkbox. The resolution ladder is cut to what the SOURCE
 * can feed (screens by physical display size, windows by client rect, cameras
 * by the preview's capabilities — user decision: never offer quality above
 * the source; "Source" is the uncapped floor).
 */
export function SharePickerModal({ onTarget, onClose }: {
  onTarget(target: ShareTarget): void;
  onClose(): void;
}): React.JSX.Element {
  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<PickerTab>("screen");
  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether window shares can carry per-app audio (#485 native capture) — the
  // checkbox must not promise audio the platform cannot deliver.
  const [nativeWindowAudio, setNativeWindowAudio] = useState(false);

  // --- The Quality step (oak's Picker state machine) ---
  const savedPresets = useStore(settingsStore, (settings) => settings.sharePresets);
  /** The selected combo preset; null = Custom (the segments are the pick). */
  const [comboValue, setComboValue] = useState<SavedSharePreset | null>(null);
  const [segmentState, setSegmentState] = useState<ShareQuality>(DEFAULT_PICKER_QUALITY);
  const [segmentDirty, setSegmentDirty] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [includeAudio, setIncludeAudio] = useState(true);
  // The preset combo is a custom dropdown (a native <select> cannot host a
  // per-row delete button — user request 2026-09-21).
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);

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

  /** The picked source's pixel size (screens physical, windows client-rect,
   *  cameras the preview device's capabilities) — null = unknown, no cutoff. */
  const sourceSize = useMemo(() => {
    if (tab === "camera") {
      const capabilities = previewStream?.getVideoTracks()[0]?.getCapabilities();
      return { width: capabilities?.width?.max ?? null, height: capabilities?.height?.max ?? null };
    }
    const picked = sources.find((source) => source.id === selected) ?? null;
    return { width: picked?.sourceWidth ?? null, height: picked?.sourceHeight ?? null };
  }, [tab, sources, selected, previewStream]);

  const currentQuality = resolveQuality(segmentDirty, comboValue, segmentState);

  /** oak's step swap: the default (Medium, user decision) clamped to what the
   *  source can feed; the combo pre-selects the preset when the clamped value
   *  IS one, Custom otherwise. The audio checkbox seeds from the per-kind
   *  persisted flag. */
  const goStepTwo = (): void => {
    const clamped = clampQualityToSource(DEFAULT_PICKER_QUALITY, sourceSize.width, sourceSize.height);
    setSegmentState(clamped);
    setSegmentDirty(false);
    setComboValue([...BUILTIN_PRESETS, ...savedPresets].find((preset) =>
      preset.fps === clamped.fps
      && preset.width === clamped.width
      && preset.height === clamped.height
      && preset.bitrate === clamped.bitrate) ?? null);
    const snapshot = settingsStore.getSnapshot();
    setIncludeAudio(tab === "window" ? snapshot.shareWindowAudio : snapshot.shareScreenAudio);
    setPresetName("");
    setStep(2);
  };

  const chooseSegment = (patch: Partial<ShareQuality>): void => {
    setSegmentState((current) => ({ ...current, ...patch }));
    setSegmentDirty(true); // a touched segment beats the combo preset (oak)
  };

  const onPresetChosen = (preset: SavedSharePreset): void => {
    setSegmentState({ fps: preset.fps, width: preset.width, height: preset.height, bitrate: preset.bitrate });
    setSegmentDirty(false);
    setComboValue(preset);
  };

  const savePreset = (): void => {
    const trimmed = presetName.trim();
    if (trimmed.length === 0) {
      return;
    }
    settingsStore.apply({ sharePresets: upsertPreset(savedPresets, trimmed, currentQuality) });
    setComboValue({ ...currentQuality, name: trimmed }); // name LAST — a leaked name must not win
    setSegmentDirty(false);
    setPresetName("");
  };

  /** Delete a SAVED preset (builtin ones are code). Deleting the very preset
   *  backing the combo drops it to Custom — the segments already carry the
   *  same values, so the effective quality does not move. The menu stays open
   *  so several presets can be cleaned up in a row. */
  const deletePreset = (preset: SavedSharePreset): void => {
    settingsStore.apply({ sharePresets: savedPresets.filter((candidate) => candidate !== preset) });
    if (comboValue === preset) {
      setComboValue(null);
    }
  };

  // The dropdown closes on outside clicks and Escape (capture + stopPropagation
  // — the Escape must not fall through and close the whole modal).
  useEffect(() => {
    if (!presetMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (presetMenuRef.current !== null && !presetMenuRef.current.contains(event.target as Node)) {
        setPresetMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPresetMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [presetMenuOpen]);

  const audioCheckboxVisible = tab === "screen" || (tab === "window" && nativeWindowAudio);

  const share = (): void => {
    if (selected === null) {
      return;
    }
    if (tab === "camera") {
      stopPreview(); // hand the device over to the real capture
    } else {
      // oak's commitShare: the checkbox state becomes the next share's seed.
      settingsStore.apply(tab === "screen" ? { shareScreenAudio: includeAudio } : { shareWindowAudio: includeAudio });
    }
    onTarget({ kind: tab, id: selected, quality: currentQuality, includeAudio: tab !== "camera" && includeAudio });
  };

  // The combo's selected key: Custom while dirty (or nothing chosen), else the
  // entry that deep-equals the combo value (a saved preset object identity is
  // not stable across the settings re-render).
  const comboEntries = useMemo(() => [
    ...BUILTIN_PRESETS.map((preset) => ({ key: `builtin:${preset.name.toLowerCase()}`, preset })),
    ...savedPresets.map((preset) => ({ key: `saved:${preset.name.toLowerCase()}`, preset })),
  ], [savedPresets]);
  // Match by NAME + values: a saved preset with a builtin's VALUES (saved
  // straight off the default, nothing touched) must select ITS row, not the
  // builtin's — builtin entries come first in the list.
  const selectedComboKey = segmentDirty || comboValue === null
    ? "custom"
    : comboEntries.find((entry) =>
      entry.preset.name === comboValue.name
      && entry.preset.fps === comboValue.fps
      && entry.preset.width === comboValue.width
      && entry.preset.height === comboValue.height
      && entry.preset.bitrate === comboValue.bitrate)?.key ?? "custom";
  const selectedComboLabel = selectedComboKey === "custom"
    ? "Custom"
    : presetLabel(comboEntries.find((entry) => entry.key === selectedComboKey)!.preset);

  const resolutionChoices = useMemo(
    () => feasibleResolutions(sourceSize.width, sourceSize.height),
    [sourceSize.width, sourceSize.height]);

  return (
    <Modal title={step === 1 ? "Share your screen" : "Quality"} onClose={onClose}>
      {step === 1 ? (
        <>
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
          <div className="modal-actions">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={selected === null} onClick={goStepTwo}>Next</button>
          </div>
        </>
      ) : (
        <>
          <div className="quality-step">
            <div className="quality-row">
              <span className="quality-row-label">Preset</span>
              <div className="quality-select-wrap" ref={presetMenuRef}>
                <button
                  type="button"
                  className={"quality-select-trigger" + (presetMenuOpen ? " open" : "")}
                  onClick={() => setPresetMenuOpen((open) => !open)}
                >
                  <span className="quality-select-value">{selectedComboLabel}</span>
                  <span className="icon mdi-chevron-down quality-select-arrow" />
                </button>
                {presetMenuOpen ? (
                  <div className="quality-preset-menu">
                    <div
                      className={"quality-preset-row" + (selectedComboKey === "custom" ? " chosen" : "")}
                      onClick={() => {
                        setComboValue(null); // Custom — the segments rule
                        setPresetMenuOpen(false);
                      }}
                    >
                      <span className="quality-preset-label">Custom</span>
                      {selectedComboKey === "custom" ? <span className="icon mdi-check quality-preset-check" /> : null}
                    </div>
                    {comboEntries.map((entry) => (
                      <div
                        key={entry.key}
                        className={"quality-preset-row" + (selectedComboKey === entry.key ? " chosen" : "")}
                        onClick={() => {
                          onPresetChosen(entry.preset);
                          setPresetMenuOpen(false);
                        }}
                      >
                        <span className="quality-preset-label">{presetLabel(entry.preset)}</span>
                        {selectedComboKey === entry.key ? <span className="icon mdi-check quality-preset-check" /> : null}
                        {entry.key.startsWith("saved:") ? (
                          <button
                            type="button"
                            className="quality-preset-delete"
                            title={`Delete preset "${entry.preset.name}"`}
                            onClick={(event) => {
                              event.stopPropagation(); // the row's click would choose it
                              deletePreset(entry.preset);
                            }}
                          >
                            <span className="icon mdi-close" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <SegmentRow
              label="Frame rate"
              choices={FPS_CHOICES}
              describe={(fps) => String(fps)}
              active={(fps) => segmentState.fps === fps}
              onChoose={(fps) => chooseSegment({ fps })}
            />
            <SegmentRow
              label="Resolution"
              choices={resolutionChoices}
              describe={(choice) => choice.label}
              active={(choice) => segmentState.width === choice.width && segmentState.height === choice.height}
              onChoose={(choice) => chooseSegment({ width: choice.width, height: choice.height })}
            />
            <SegmentRow
              label="Bitrate"
              choices={BITRATE_CHOICES_MBPS}
              describe={(mbps) => formatBitrate(mbps * 1_000_000)}
              active={(mbps) => segmentState.bitrate === mbps * 1_000_000}
              onChoose={(mbps) => chooseSegment({ bitrate: mbps * 1_000_000 })}
            />
            <div className="quality-save-row">
              <input
                type="text"
                value={presetName}
                placeholder="Preset name"
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    savePreset(); // oak: Enter in the name field saves
                  }
                }}
              />
              <button className="primary" disabled={presetName.trim().length === 0} onClick={savePreset}>Save</button>
            </div>
            {audioCheckboxVisible ? (
              <label
                className="quality-audio"
                title={tab === "screen"
                  ? "Share the sound of what you are sharing — the whole desktop minus this client's own sounds"
                  : "Share the sound of what you are sharing — only that application's audio"}
              >
                <input
                  type="checkbox"
                  checked={includeAudio}
                  onChange={(event) => setIncludeAudio(event.target.checked)}
                />
                {tab === "screen" ? "Include desktop audio" : "Include application audio"}
              </label>
            ) : null}
            <div className="quality-summary">Streaming at {describeQuality(currentQuality)}</div>
          </div>
          <div className="modal-actions">
            <button className="ghost" title="Back to sources" onClick={() => setStep(1)}><span className="icon mdi-chevron-left" /> Back</button>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" onClick={share}>Share</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** One labeled segment row of the Quality step (oak's segmentRow): a row of
 *  small pills with the ACTIVE value highlighted on exact match only — a
 *  saved "17 fps" highlights nothing in the fps row, exactly like oak. */
function SegmentRow<Choice>({ label, choices, describe, active, onChoose }: {
  label: string;
  choices: readonly Choice[];
  describe(choice: Choice): string;
  active(choice: Choice): boolean;
  onChoose(choice: Choice): void;
}): React.JSX.Element {
  return (
    <div className="quality-row">
      <span className="quality-row-label">{label}</span>
      <div className="quality-segments">
        {choices.map((choice) => (
          <button
            key={describe(choice)}
            className={"quality-segment" + (active(choice) ? " chosen" : "")}
            onClick={() => onChoose(choice)}
          >
            {describe(choice)}
          </button>
        ))}
      </div>
    </div>
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
