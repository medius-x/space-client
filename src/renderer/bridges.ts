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
  /** The source's pixel size (screens: physical, windows: client area) —
   *  the quality step cuts resolutions above it. Null = unknown, no cutoff. */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

export interface CaptureBridge {
  /** Optional type filter — screen-only callers skip the slow window enumeration
   *  (and Chromium's WGC "Source is not capturable" error spam). */
  sources(types?: ("screen" | "window")[]): Promise<CaptureSourceInfo[]>;
  /** Tell main which source the NEXT getDisplayMedia grant should hand out. */
  select(sourceId: string, withAudio: boolean): Promise<boolean>;
  /** Arm the window-share liveness watchdog (null cancels) — Chromium never
   *  fires the capture track's "ended" when the shared window closes. */
  watchSource(sourceId: string | null): Promise<boolean>;
  /** The watched window died — stop the share the ordinary way. */
  onSourceDead(callback: (sourceId: string) => void): void;
}

/** The pop-out viewer's subscription target: the window runs its OWN videoroom
 *  subscription (2026-09-21) instead of the M4 JPEG relay — a MediaStream
 *  cannot cross renderer contexts, but a second subscriber can. */
export interface PopoutTarget {
  janusUrl: string;
  roomId: number;
  token: string | null;
  pin: string | null;
  feedId: number;
  /** The feed's VIDEO stream mid (video-only: the main window owns the audio). */
  videoMid: string;
  /** The sharing publisher's USERNAME (feed display) — the pop-out's volume
   *  sliders are a REMOTE control for the main window's playout chains, whose
   *  gains persist per username. */
  shareUsername: string | null;
  /** False on a video-only share — the pop-out's share-volume slider disables. */
  shareAudio: boolean;
  /** The persisted SHARE gain 0..2 at retarget time. */
  shareVolume: number;
  /** The persisted VOICE gain 0..2 at retarget time (the twin regulation,
   *  user request 2026-10-19 — the pill carries the member card's two sliders). */
  voiceVolume: number;
}

/** The voice-panel mirror the main window pushes into the share pop-out: its
 *  mute/deafen/NS buttons duplicate the main window's panel (user request
 *  2026-09-25) — the pop-out has no runtime of its own, the state travels. */
export interface PopoutVoiceState {
  /** UNION of self and moderator marks — what the main panel's glyph shows. */
  muted: boolean;
  deafened: boolean;
  /** The active noise-suppression engine ("off" = the grey button). */
  nsEngine: string;
}

export interface WindowBridge {
  openPopout(): Promise<boolean>;
  /** Push the (newly) watched feed to the open pop-out; null = waiting state. */
  retargetPopout(target: PopoutTarget | null): void;
  /** Force-close the pop-out (kick/ban teardown — its Janus subscription is
   *  independent of the main window's and must not outlive the viewer). */
  closePopout(): void;
  /** The pop-out's initial target (main stores the last retarget). */
  popoutParams(): Promise<PopoutTarget | null>;
  /** Live retargets while the pop-out is open. */
  onRetarget(callback: (target: PopoutTarget | null) => void): void;
  /** The main window's "the pop-out was closed" signal. */
  onClosed(callback: () => void): void;
  /** The main window's close was FORESTALLED ~900ms: leave voice/call now. */
  onClosing(callback: () => void): void;
  /** The POP-OUT's volume sliders → the main window's playout chains (the audio
   *  lives there; the pop-out subscribes video-only — one audible stream). The
   *  kind picks the chain: "share" = the watched share, "voice" = the peer's
   *  voice (the twin regulation, 2026-10-19). */
  popoutVolume(username: string, volume: number, kind: "voice" | "share"): void;
  /** The MAIN window's sink for the pop-out sliders above. */
  onPopoutVolume(callback: (username: string, volume: number, kind: "voice" | "share") => void): void;
  /** MAIN → pop-out: a gain changed in the main window — the pop-out's matching
   *  slider follows (two-way sync). */
  pushPopoutVolume(username: string, gain: number, kind: "voice" | "share"): void;
  /** The POP-OUT's sink for the push above. */
  onPopoutVolumeSync(callback: (username: string, gain: number, kind: "voice" | "share") => void): void;
  /** The voice-panel state mirrored into the pop-out (mute/deafen/NS buttons). */
  pushPopoutVoiceState(state: PopoutVoiceState): void;
  /** The pop-out's initial voice-panel state (main keeps the last pushed). */
  popoutVoiceState(): Promise<PopoutVoiceState | null>;
  /** The POP-OUT's sink for voice-state pushes. */
  onPopoutVoiceState(callback: (state: PopoutVoiceState) => void): void;
  /** The pop-out's voice-panel buttons → the main window's actions. */
  popoutVoiceAction(action: "toggle-mute" | "toggle-deafen", engine?: undefined): void;
  popoutVoiceAction(action: "ns-engine", engine: string): void;
  /** The MAIN window's sink for the actions above. */
  onPopoutVoiceAction(callback: (action: "toggle-mute" | "toggle-deafen" | "ns-engine", engine: string | null) => void): void;
  /** Toggle the SENDER window's fullscreen (the pop-out's ⛶ button). */
  toggleFullscreen(): void;
  /** Fullscreen flips of the sender window (restore-glyph swap, Esc-to-leave). */
  onFullscreenChange(callback: (fullscreen: boolean) => void): void;
  /* Caption-bar controls of the borderless main window (oak chrome). */
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /** Bring the window forward — restore from minimized / show from tray / focus. */
  raise(): void;
  onMaximizedChange(callback: (maximized: boolean) => void): void;
}

/** The capture-start result as it crosses IPC. */
export interface SysAudioStartInfo {
  started: boolean;
  mode: "exclude-self" | "include";
  pid: number;
}

/** Native system-audio bridge (#485): WASAPI process-loopback — frames arrive
 *  as interleaved stereo Int16 at the ~10 ms cadence (legacy push mode; with
 *  a returned ring the data path is shared memory instead). Without a source
 *  id the capture is the whole desktop minus OUR process; a window source id
 *  ("window:HWND:…") captures only that application's process tree. */
export interface SysAudioBridge {
  available(): Promise<boolean>;
  start(sourceId?: string): Promise<SysAudioStartInfo>;
  stop(): Promise<void>;
  onFrame(callback: (pcm: Int16Array, silent: boolean) => void): void;
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

/** The VOICE-INVITE card (Discord's "invite to voice channel"): who invites,
 *  into which room of which server. Unlike the call card it stacks with the
 *  message toasts and TTLs out on its own (~60 s) — a room invite is a nudge,
 *  not an event that outranks anything. */
export interface ToastVoiceInviteCardPayload {
  /** The main window's id — Join/Dismiss route back by it. */
  id: number;
  /** The inviter's NICKNAME (the rename model). */
  inviterName: string;
  /** The channel's display name, resolved by the SENDER's server (the
   *  receiver's store may not hold the room at all). */
  channelName: string;
  serverName: string;
  avatarUrl: string | null;
  avatarColor: string;
  dismissSeconds: number;
}

/** Everything the MAIN window can push into the toast window. The call card
 *  outranks message toasts: while it is up, the stack drops its cards and
 *  refuses new ones (user decision — a ringing call is the louder event). */
export type ToastShowPayload =
  | { kind: "message"; card: ToastCardPayload }
  | { kind: "call"; card: ToastCallCardPayload }
  | { kind: "call-status"; status: ToastCallCardPayload["status"] }
  | { kind: "call-end" }
  | { kind: "voice-invite"; card: ToastVoiceInviteCardPayload }
  | { kind: "voice-invite-end"; id: number };

export interface ToastBridge {
  /** MAIN window → the toast window: show a card / drive the call card. */
  show(payload: ToastShowPayload): void;
  /** TOAST window → main: a card was clicked (main relays to the main window). */
  clicked(id: number): void;
  /** TOAST window → main: the call card's Accept/Decline was pressed. */
  callAction(action: "accept" | "decline"): void;
  /** TOAST window → main: a voice-invite card's Join/Dismiss was pressed. */
  voiceInviteAction(action: "join" | "dismiss", id: number): void;
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
  /** The main window's voice-invite sink (Join/Dismiss run in the runtime). */
  onVoiceInviteAction(callback: (action: "join" | "dismiss", id: number) => void): void;
}

/** Per-action outcome of a global-chord registration: "taken" = the OS chord is
 *  held by another process (a second dev instance, another application) — the
 *  settings section badges the row instead of pretending it works. */
export type HotkeyRegistrationStatus = "ok" | "taken";

export interface HotkeyBridge {
  /** Push the FULL global set — main re-registers wholesale. */
  sync(entries: { id: string; accelerator: string }[]): Promise<Record<string, HotkeyRegistrationStatus>>;
  /** A global chord fired (main → the main window only). */
  onHotkey(callback: (actionId: string) => void): void;
}

/** System-idle bridge (the AFK sweep's activity source): seconds since the last
 *  OS-wide user input, from Electron's powerMonitor in main. */
export interface IdleBridge {
  getSystemIdleTime(): Promise<number>;
  /** Arm the MAIN-PROCESS 30 s AFK tick (a renderer interval starves on a
   *  hidden window — the same class the share-audio ring closed). Optional:
   *  older preloads lack it and the runtime falls back to its own interval. */
  armAfkTicker?(armed: boolean): void;
  /** The tick push: main measured the system idle and wants a heartbeat
   *  decision (the STOMP send itself lives in the renderer). */
  onAfkTick?(callback: (idleSeconds: number) => void): void;
}

/** An untrusted server certificate main rejected and surfaced for a trust
 *  decision (TLS entry point, round B). `fingerprint` is the NORMALIZED hex
 *  (no separators); `displayFingerprint` is the colon-separated form for the
 *  dialog. `changedPinned` marks the dangerous case: a PINNED host presented
 *  a different certificate (possible MITM). */
export interface TlsUntrustedEvent {
  hostname: string;
  fingerprint: string;
  displayFingerprint: string;
  subjectName: string;
  changedPinned: boolean;
}

export interface TlsCertBridge {
  /** The user's trust decision for a hostname. Accept stores a SESSION
   *  allowance (main lets the fingerprint through and pins it into the
   *  server record on its next write); Reject blocks and forgets. */
  decide(decision: { hostname: string; fingerprint: string; accept: boolean }): Promise<boolean>;
  /** Main → the main window: a certificate needs a decision. */
  onUntrusted(callback: (event: TlsUntrustedEvent) => void): void;
}

// ---------------------------------------------------------------------------
// Provisioning (round C): the Create tab's SSH deployment of a fresh server
// ---------------------------------------------------------------------------

/** The form the Create tab submits. SSH credentials stay in the IPC call —
 *  they are never persisted and never logged on either side. */
export interface ProvisioningFormParams {
  host: string;
  sshPort: number;
  sshLogin: string;
  sshPassword: string | null;
  sshKeyPath: string | null;
  sshKeyPassphrase: string | null;
  domain: string | null;
  firewall: boolean;
  /** The Space account (OWNER): the panel resolves empty fields to the
   *  admin/admin/password defaults before submitting. */
  adminLogin: string;
  adminNickname: string | null;
  adminPassword: string;
  jarPath: string | null;
  /** Local path to a backup archive (backup round 2026-10-28): the deployment
   *  restores it instead of registering a fresh owner. Null = normal setup. */
  backupArchivePath: string | null;
  /** True ONLY for the Migrate flow: the archive was taken by the run's own
   *  backup step into the OS temp dir and is ONE-SHOT — the main process
   *  deletes it when the run ends any way (success, failure, cancel). */
  migrationArchive?: boolean;
  /** The DIRECT server-to-server transfer (2026-11-02): the restore stage has
   *  the new server pull the archive from the old one (curl + the one-shot
   *  token). Mutually exclusive with backupArchivePath. */
  migrationTransfer?: {
    sourceUrl: string;
    token: string;
    archiveSha256: string;
    archiveBytes: number;
    certificatePem: string | null;
  } | null;
}

/** One pipeline stage report; "connect" and "download" are main-side stages
 *  wrapped around the SSH stages proper (probe…register). */
export interface ProvisioningStepIpcEvent {
  kind: "step";
  stage: "connect" | "download" | "probe" | "docker" | "layout" | "upload" | "env"
    | "certificate" | "firewall" | "compose" | "wait" | "restore" | "register";
  state: "start" | "done" | "log" | "failed";
  detail?: string;
  /** Live progress of the active step (byte counter / last output line). */
  progress?: string;
}

/** The successful end of a run — everything the automatic login needs. */
export interface ProvisioningOutcomeIpc {
  hostUrl: string;
  /** The self-signed certificate's normalized SHA-256 pin (null on a domain
   *  deployment — CA-signed, nothing to pin). Main pre-trusts it: the
   *  fingerprint arrived over the SSH channel, not an open network. */
  certFingerprint: string | null;
  /** False when the admin account exists with a DIFFERENT password (an adopt
   *  re-run) — the user logs in manually with the old one. */
  ownerReady: boolean;
  adminUsername: string;
  /** True when the deployment RESTORED a backup archive: accounts come from
   *  the archive, the owner's password is the user's alone — the finish phase
   *  is needsLogin, no automatic login is attempted. */
  restored: boolean;
}

export type ProvisioningIpcEvent =
  | ProvisioningStepIpcEvent
  | { kind: "succeeded"; outcome: ProvisioningOutcomeIpc }
  | { kind: "failed"; stage: string; message: string };

/** The migration probe's request (the SSH fields of the provisioning form plus
 *  the transfer source); main resolves the OLD server's pinned fingerprint
 *  itself — the pin store lives in the main process. */
export interface MigrationProbeRequestBridge {
  host: string;
  sshPort: number;
  sshLogin: string;
  sshPassword: string | null;
  sshKeyPath: string | null;
  sshKeyPassphrase: string | null;
  sourceUrl: string;
  token: string;
}

export interface MigrationProbeResultBridge {
  direct: boolean;
  reason: string;
  certificatePem: string | null;
}

export interface ProvisioningBridge {
  /** Start a run; false = rejected outright (already running / bad params). */
  start(params: ProvisioningFormParams): Promise<boolean>;
  /** Drop the SSH connection — the in-flight step fails as "cancelled". */
  cancel(): Promise<boolean>;
  /** The migration leg's reachability probe (2026-11-02): one curl from the
   *  NEW server against the OLD one's transfer endpoint — direct=true arms
   *  the server-to-server route, false falls back to this computer. */
  probeMigration(request: MigrationProbeRequestBridge): Promise<MigrationProbeResultBridge>;
  /** SHA-256 of a downloaded migration archive (temp/downloads only; null =
   *  unreadable path or read error). */
  hashFile(absolutePath: string): Promise<string | null>;
  /** The step/result stream (single subscriber). */
  onEvent(callback: (event: ProvisioningIpcEvent) => void): void;
}

/** A self-update check's outcome as main reports it ("unsupported" = a dev
 *  build — the updater never arms there). */
export interface UpdateCheckResult {
  status: "available" | "none" | "error" | "unsupported";
  version: string | null;
  message: string | null;
}

/** The self-update lifecycle events main pushes: download progress, the
 *  finished download (the renderer then installs), a user cancel, a failure. */
export type UpdateStateEvent =
  | { kind: "downloading"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

/** Self-update bridge (2026-10-20): the checks and the user-initiated download
 *  ride IPC; every byte of update traffic starts from an explicit click. */
export interface UpdatesBridge {
  /** Dev banner smoke (--space-fake-update): true when the app was launched
   *  with the flag — runtime seeds a fake "update available" so the banner's
   *  layout can be checked in dev (the real updater is packaged-only). */
  readonly fakeUpdateAvailable: boolean;
  check(): Promise<UpdateCheckResult>;
  /** The client's own version — package.json in dev, the exe version when
   *  packaged (Diagnostics, user request 2026-10-27). */
  getVersion(): Promise<string>;
  download(): Promise<{ started: boolean; reason: string | null }>;
  cancelDownload(): void;
  install(): void;
  onState(callback: (event: UpdateStateEvent) => void): void;
}

/** UI-language bridge (localization round 2026-10-27): the main window
 *  resolves the setting and pushes the result; main re-labels the tray and
 *  window titles and broadcasts flips to EVERY renderer (the toast and
 *  pop-out windows run without bootstrapApp, so their only language source
 *  is this bridge). */
export interface I18nBridge {
  /** Renderer → main: the resolved language ("en" | "ru"). */
  sync(lang: string): void;
  /** The aux windows' startup value (main knows the last synced language). */
  get(): Promise<string>;
  /** Main → every window: the language flipped (single listener slot). */
  onLanguage(callback: (lang: string) => void): void;
}

/** The result of a main-process backup download. */
export type BackupDownloadOutcome =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: string };

/** Server-backup bridge (backup round 2026-10-28): MAIN streams the (possibly
 *  gigabyte) archive straight to the backup folder — the renderer's heap never
 *  sees the bytes — and prunes old copies by the retention policy. */
export interface BackupsBridge {
  /** The effective backup folder + whether the user configured it. */
  info(): Promise<{ folder: string; configured: string | null } | null>;
  /** The OS folder picker for a custom backup folder; null = canceled. */
  chooseFolder(): Promise<string | null>;
  /** The OS file picker for a backup ARCHIVE (the provisioning restore field). */
  chooseArchive(): Promise<string | null>;
  /** Reveal the backup folder in the OS file manager; returns the folder. */
  openFolder(): Promise<string | null>;
  /** Stream one archive to disk; the Bearer rides IPC (a local corridor of one
   *  app — the authorization decision stays the server's). Target "temp" serves
   *  the migration one-shot (the OS temp dir, no retention). */
  download(url: string, fileName: string, bearer: string, target?: "backup" | "temp"): Promise<BackupDownloadOutcome>;
  /** Keep the newest N files of one server's prefix; returns the deleted names. */
  prune(prefix: string, keepCount: number): Promise<string[]>;
  /** Delete ONE file from the migration temp dir (a full path or a bare name —
   *  only the basename is used). The migration flow's one-shot cleanup when the
   *  user cancels before the SSH run starts. */
  deleteTemp(name: string): Promise<boolean>;
  /** Live download progress (~4 Hz, main window only). */
  onProgress(callback: (event: { fileName: string; receivedBytes: number; totalBytes: number | null }) => void): void;
}

declare global {
  interface Window {
    spaceCapture?: CaptureBridge;
    spaceWindow?: WindowBridge;
    spaceSysAudio?: SysAudioBridge;
    spaceToast?: ToastBridge;
    spaceHotkey?: HotkeyBridge;
    spaceIdle?: IdleBridge;
    spaceTls?: TlsCertBridge;
    spaceProvisioning?: ProvisioningBridge;
    spaceUpdates?: UpdatesBridge;
    spaceI18n?: I18nBridge;
    spaceBackup?: BackupsBridge;
  }
}
