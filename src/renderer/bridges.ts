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
  /* Caption-bar controls of the borderless main window (oak chrome). */
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  onMaximizedChange(callback: (maximized: boolean) => void): void;
}

/** One card in the always-on-top toast window (oak's NotificationToast). */
export interface ToastCardPayload {
  id: number;
  title: string;
  channelName: string;
  body: string;
  /** Optional pre-split body: mention spans render tinted, plain text doesn't.
   *  Absent on system toasts (Voice/Call/jump) — they render `body` as is. */
  segments?: { text: string; mention: boolean }[];
  mention: boolean;
  dismissSeconds: number;
  maxToasts: number;
}

/** The sticky INCOMING-CALL card (oak's CallOverlay, living in the toast
 *  window): the caller's avatar, the server the call comes from, and the
 *  status that flips to "Connecting…" after Accept. No TTL — the call machine
 *  tears it down. */
export interface ToastCallCardPayload {
  peer: string;
  serverName: string;
  /** Presigned avatar URL (auth-free) — null renders the palette-initial fallback. */
  avatarUrl: string | null;
  /** The palette color for the initial fallback (the palette lives in domain). */
  avatarColor: string;
  status: "Incoming call" | "Connecting…";
}

/** Everything the MAIN window can push into the toast window. The call card
 *  outranks message toasts: while it is up, the stack drops its cards and
 *  refuses new ones (user decision — a ringing call is the louder event). */
export type ToastShowPayload =
  | { kind: "message"; card: ToastCardPayload }
  | { kind: "call"; card: ToastCallCardPayload }
  | { kind: "call-status"; status: ToastCallCardPayload["status"] }
  | { kind: "call-end" };

export interface ToastBridge {
  /** MAIN window → the toast window: show a card / drive the call card. */
  show(payload: ToastShowPayload): void;
  /** TOAST window → main: a card was clicked (main relays to the main window). */
  clicked(id: number): void;
  /** TOAST window → main: the call card's Accept/Decline was pressed. */
  callAction(action: "accept" | "decline"): void;
  /** TOAST window → main: the cursor is (not) over actual content. */
  hover(interactive: boolean): void;
  /** TOAST window → main: the stack's rendered height (window resize). */
  geometry(contentHeight: number): void;
  /** TOAST window → main: the stack is empty — hide the window. */
  empty(): void;
  /** TOAST window → main: the IPC subscription is up — flush buffered cards. */
  ready(): void;
  /** The toast window's card sink. */
  onShow(callback: (payload: ToastShowPayload) => void): void;
  /** The main window's card-click sink (runs the stored onClick callback). */
  onClicked(callback: (id: number) => void): void;
  /** The main window's call-action sink (Accept/Decline run in the runtime). */
  onCallAction(callback: (action: "accept" | "decline") => void): void;
}

declare global {
  interface Window {
    spaceCapture?: CaptureBridge;
    spaceWindow?: WindowBridge;
    spaceToast?: ToastBridge;
  }
}
