/**
 * Renderer-side shapes of the M4 preload bridges (capture picker sources and the
 * share pop-out window). Both are optional — dev tooling and tests may load the
 * renderer without the preload.
 */

export interface CaptureSourceInfo {
  /** desktopCapturer source id ("screen:0:0" / "window:123:0"). */
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A small preview frame as a data URL (may be missing for some windows). */
  thumbnailDataUrl: string | null;
}

export interface CaptureBridge {
  sources(): Promise<CaptureSourceInfo[]>;
  /** Tell main which source the NEXT getDisplayMedia grant should hand out. */
  select(sourceId: string, withAudio: boolean): Promise<boolean>;
}

export interface WindowBridge {
  openPopout(): Promise<boolean>;
  /** A JPEG frame for the pop-out viewer (main relays it to the popout window). */
  sendFrame(dataUrl: string): void;
  /** The pop-out window's frame sink. */
  onFrame(callback: (dataUrl: string) => void): void;
  /** The main window's "the pop-out was closed" signal. */
  onClosed(callback: () => void): void;
}

declare global {
  interface Window {
    spaceCapture?: CaptureBridge;
    spaceWindow?: WindowBridge;
  }
}
