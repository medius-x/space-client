import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { MemoryTokenStorage } from "../core/auth";
import { ApiError, RestClient } from "../core/rest";
import { JanusClient } from "../core/janus";
import { SfuSession, RoomVanishedError, SubscriberTransportError, PublisherTransportError, type MediaSource, type VideoRtpCounters } from "../core/sfu";
import { PeerCallSession, type PeerCallOptions, type PeerTrackKind } from "../core/peer-call";
import { feedHasLiveVideo, feedHasShareAudio } from "../core/classifier";
import { extractAudioFmtpLines } from "../core/sdp";
import { rmsToDbfs, stereoVerdict } from "../core/audio-math";
import { RoomAudio } from "../media/RoomAudio";
import { createNoisePipeline, noisePipelineStillWanted, type NoiseEngineKind, type NoisePipeline } from "../media/noise-suppression";
import { createShareSubtraction, suppressionDb } from "../media/share-subtraction";
import { createSystemAudioSource, type SystemAudioSource } from "../media/system-audio-source";
import { acquireNativeShareAudioTrack, isNativeShareActive, isShareMonitorWanted, monitorActiveShare, releaseNativeShareAudio, setActiveShareMonitorSink } from "../media/native-share-audio";
import { modulatedNoise } from "../domain/logic/share-recenter";
import { matchDeviceId } from "../domain/logic/device-match";
import { cameraVideoConstraints, describeQuality, displayVideoConstraints, type ShareQuality } from "../domain/logic/share-quality";
import {
  ConnectionDirectory,
  DEFAULT_NOTIFICATION_PREFS,
  EXPIRED_MARKER,
  normalizeHostUrl,
  RecordTokenStorage,
} from "../domain/session/connection-record";
import { ConnectionSession, type SessionHooks } from "../domain/session/connection-session";
import { MAX_VOICE_REJOIN_ATTEMPTS, rejoinDelayMs, rejoinExhausted } from "../domain/logic/rejoin-ladder";
import { dmDisplayName } from "../domain/logic/dm-display";
import type { MentionIdentity } from "../domain/logic/notification-decider";
import type { ConnectionRecord } from "../domain/session/connection-record";
import { messageHasEveryoneHere, messageMentionsRole, messageMentionsUser } from "../domain/logic/notification-decider";
import { dmToastHeader, toastBodyFallback, toastServerHeader } from "../domain/logic/toast-preview";
import { paletteColor } from "../domain/logic/user-palette";
import { displayNameOf } from "../domain/logic/display-name";
import { isAfkActive } from "../domain/logic/afk-activity";
import { initialConnectionQuality, type ConnectionQualitySnapshot } from "../domain/logic/connection-quality";
import { memberKickReasonText, memberKickTitle } from "../domain/logic/moderation-reason";
import type { TlsUntrustedEvent } from "./bridges";
import { SettingsStore, type ClientSettings } from "../domain/stores/SettingsStore";
import {
  acceleratorFromKeyboardEvent,
  adjacentChannelId,
  globalBindingsForSync,
  isBareKeyAccelerator,
  KEYBIND_ACTIONS,
  resolveKeybinds,
  voiceSurfaceFor,
  type ActionId,
} from "../domain/logic/keybinds";
import type { NotificationPrefs } from "../types";
import { notifications } from "./notifications";
import {
  bindLiveBackgroundSession,
  hasLiveSession,
  loadBackgroundSocial,
  socialDirectory,
  unbindLiveBackgroundSession,
} from "./social-aggregate";
import { virtualScrollTelemetry } from "./scroll-telemetry";
import type {
  CallConfig,
  Channel,
  FeedInfo,
  IncomingCallSignal,
  IncomingVoiceInvite,
  Message,
  RemoteTrackKind,
  RoomInfo,
  VoiceControlState,
  VoiceRoomState,
} from "../types";

/**
 * The application runtime — a MODULE SINGLETON, deliberately outside the React tree:
 * Fast Refresh only reloads components, so editing UI code never tears down WebRTC,
 * STOMP sessions or the audio graph. M1 splits the per-connection world into
 * ConnectionSession (domain); what remains here is the app shell: the connection
 * directory, the ONE active session binding, and the voice room plumbing.
 */

export type FriendsTab = "ALL" | "ONLINE" | "PENDING" | "BLOCKED" | "ADD_FRIEND";

export interface AppState {
  /** The login form is a MODAL over the always-present main window (oak's Add
   *  Server dialog) — the window itself never becomes a login screen. */
  loginFormOpen: boolean;
  loginError: string | null;
  loginBusy: boolean;
  loginPrefill: { url: string; username: string } | null;
  ownUsername: string | null;
  baseUrl: string;
  /** Active TEXT channel (the chat pane); null = nothing selected yet. */
  activeChannelId: number | null;
  /** Home mode: the sidebar shows the DM list, the content shows Friends or a DM chat. */
  dmMode: boolean;
  /** The open DM inside dmMode; null = the Friends pane. Kept SEPARATE from activeChannelId (the server channel survives a Home round-trip). */
  activeDmId: number | null;
  friendsTab: FriendsTab;
  activeVoiceChannelId: number | null;
  voiceState: VoiceRoomState;
  stateDetail: string | null;
  /** Media-path RTT of the live voice transport (publisher candidate pair,
   *  ms) — the voice badge's "· N ms". NULL while not established; distinct
   *  from the STOMP ping (signalling) by design. */
  voiceRttMillis: number | null;
  participants: FeedInfo[];
  sharing: boolean;
  cameraOn: boolean;
  /** The share pop-out window is up — the main window pumps frames into it. */
  popoutActive: boolean;
  callState: "idle" | "ringing-out" | "ringing-in" | "connecting" | "in-call";
  callPeer: string | null;
  callHealthy: boolean;
  callSeconds: number;
  callCameraOn: boolean;
  callSharing: boolean;
  /** OWN call-local mic/deafen state (reactive mirror of the PeerCallSession,
   *  so the voice bar and the self tile don't poll the session). */
  callMicOn: boolean;
  callDeafenedOn: boolean;
  peerMicOn: boolean;
  peerDeafenedOn: boolean;
  peerCameraOn: boolean;
  peerScreenOn: boolean;
  /** The room↔call exclusivity question awaiting the user's answer. */
  callConflict: { kind: "start-call" | "accept-call" | "join-voice"; peer: string | null; voiceChannelId: number | null } | null;
  testToneChannel: "left" | "right" | null;
  viewingFeedId: number | null;
  /** The voice ROOM VIEW occupies the chat area (oak: swap-in by clicking the voice bar). */
  roomViewOpen: boolean;
  diagOpen: boolean;
  stompState: "off" | "connecting" | "connected" | "lost";
  /** 1-based while a reconnect is scheduled/flying (0 = none) — "M/10". */
  stompAttempt: number;
  /** Seconds left until the scheduled attempt fires (null = no countdown). */
  stompCountdown: number | null;
  /** The ACTIVE session's ping-indicator snapshot (RTT over the STOMP socket;
   *  the user bar renders it while stompState === "connected"). */
  connectionQuality: ConnectionQualitySnapshot;
  /** Server settings screen (in-app, replaces the content area) — M7. */
  serverSettingsOpen: boolean;
  serverSettingsSection: "overview" | "roles" | "members" | "invites" | "channels" | "emojis" | "stickers" | "server";
  /** User settings modal — M7. The SCOPE splits the sections (user decision
   *  2026-09-21): "account" = General + Account (opened from the server
   *  header's dropdown — server-scoped identity), "client" = everything else
   *  (the ⚙ user-bar button). */
  userSettingsOpen: boolean;
  userSettingsScope: "client" | "account";
  /** A DM on a NON-active instance the user clicked in the aggregated list:
   *  consumed by openSession once that instance is up (oak's pendingOpenDm). */
  pendingOpenDm: { recordId: string; dmId: number } | null;
  /** A SERVER channel on a NON-active instance (a background toast click) —
   *  consumed by openSession after start, same contract as pendingOpenDm. */
  pendingOpenChannel: { recordId: string; channelId: number } | null;
  /** The search panel (right column, swaps the roster) — Ctrl+F / the header loupe. */
  searchOpen: boolean;
  /** The panel's scope: the open channel (or DM) vs the whole server. */
  searchScope: "channel" | "server";
  /** A just-clicked search result: open this channel ON that message (the around
   *  window). Consumed by MessageList's first layout, which scrolls to it, flashes
   *  the highlight and nulls the field. */
  activeAround: { channelId: number; messageId: number } | null;
  /** The OPEN discussion view: the parent channel stays the active channel (the
   *  sidebar highlight), the chat area swaps to the thread (origin panel + the
   *  thread's own message list/composer; discussionId===null is the LAZY-CREATE draft that
   *  materialises on the first reply). Cleared by every channel/DM switch. */
  activeDiscussion: { channelId: number; discussionId: number | null; originMessageId: number } | null;
  /** The sidebar's channels↔discussions toggle (the discussions list replaces the
   *  channel list under the same server header). */
  sidebarDiscussions: boolean;
  /** A thread of a NON-active instance (a background mention toast click): consumed by
   *  openSession once that instance is up — same contract as pendingOpenChannel. */
  pendingOpenDiscussion: { recordId: string; discussionId: number } | null;
  /** The server dropdown (settings/re-login/delete), opened by BOTH the Sidebar's
   *  server-name header and a right-click on the rail's server avatar (the old
   *  pre-2026-09-21 rail affordance, restored 2026-09-24). The recordId targets the
   *  ROW — session-bound entries appear only for the ACTIVE record. Rendered by
   *  ServerMenu.tsx. */
  serverMenu: { recordId: string; x: number; y: number } | null;
  /** The owner's "Transfer ownership" flow (Server Settings → Members → the member's
   *  Transfer ownership button, owner-only). Rendered by TransferOwnershipModal.tsx
   *  against the ACTIVE session; ownershipPreselect carries the picked member's id
   *  (null = open at the picker step). */
  ownershipModalOpen: boolean;
  ownershipPreselect: number | null;
  /** An untrusted server certificate awaiting the user's trust decision (TLS entry
   *  point, round B): main rejected the connection and surfaced the fingerprint.
   *  Rendered by TlsTrustModal (App level — the prompt can arrive for a BACKGROUND
   *  session with the login form closed). */
  tlsPrompt: TlsUntrustedEvent | null;
  /** The boot ladder's record name once it stops painting "Connecting…" — the
   *  empty screen shows the honest "could not reach, retrying in background"
   *  wording while the ladder keeps trying silently. Null = no offline notice. */
  bootRetryNotice: string | null;
  /** The login/register attempt to re-run after a Trust decision (the rejected
   *  attempt died before reaching the server). Set by LoginModal on every submit. */
  tlsRetry: (() => void) | null;
}

class AppStore extends Emitter {
  private state: AppState = {
    loginFormOpen: false,
    loginError: null,
    loginBusy: false,
    loginPrefill: null,
    ownUsername: null,
    baseUrl: "",
    activeChannelId: null,
    dmMode: false,
    activeDmId: null,
    friendsTab: "ALL",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    voiceRttMillis: null,
    participants: [],
    sharing: false,
    cameraOn: false,
    popoutActive: false,
    callState: "idle",
    callPeer: null,
    callHealthy: true,
    callSeconds: 0,
    callCameraOn: false,
    callSharing: false,
    callMicOn: true,
    callDeafenedOn: false,
    peerMicOn: true,
    peerDeafenedOn: false,
    peerCameraOn: false,
    peerScreenOn: false,
    callConflict: null,
    testToneChannel: null,
    viewingFeedId: null,
    roomViewOpen: false,
    diagOpen: false,
    stompState: "off",
    stompAttempt: 0,
    stompCountdown: null,
    connectionQuality: initialConnectionQuality(),
    serverSettingsOpen: false,
    serverSettingsSection: "overview",
    userSettingsOpen: false,
    userSettingsScope: "client",
    pendingOpenDm: null,
    pendingOpenChannel: null,
    searchOpen: false,
    searchScope: "channel",
    activeAround: null,
    activeDiscussion: null,
    sidebarDiscussions: false,
    pendingOpenDiscussion: null,
    serverMenu: null,
    ownershipModalOpen: false,
    ownershipPreselect: null,
    tlsPrompt: null,
    tlsRetry: null,
    bootRetryNotice: null,
  };

  getSnapshot = (): AppState => this.state;

  patch(partial: Partial<AppState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as (keyof AppState)[]) {
      if (this.state[key] !== partial[key]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      this.state = { ...this.state, ...partial };
      this.emit();
    }
  }
}

export const appStore = new AppStore();
export const roomAudio = new RoomAudio();
export const connectionDirectory = new ConnectionDirectory();
/** App-wide client settings (instant-apply, KV-persisted) — M7. */
export const settingsStore = new SettingsStore();

/** Per-action outcome of the OS chord registration, as main reports it ("taken" =
 *  another process holds the chord — a second dev instance or a foreign app).
 *  The Keybinds settings section badges those rows instead of pretending. */
class KeybindStatusStore extends Emitter {
  private status: Partial<Record<ActionId, "ok" | "taken">> = {};

  getSnapshot = (): Partial<Record<ActionId, "ok" | "taken">> => this.status;

  setAll(next: Partial<Record<ActionId, "ok" | "taken">>): void {
    this.status = next;
    this.emit();
  }
}

export const keybindStatusStore = new KeybindStatusStore();

/** The single active session (v1). Login flow and the rail re-point it. */
let activeSession: ConnectionSession | null = null;
/** oak phase 2: every saved record holds a LIVE session; the map carries the
 *  BACKGROUND ones. Switching PROMOTES a background session in place — its
 *  socket and subscriptions survive the switch (no teardown, no handshake). */
const sessionMap = new Map<string, ConnectionSession>();

class SessionBinding extends Emitter {
  getSnapshot = (): ConnectionSession | null => activeSession;

  set(next: ConnectionSession | null): void {
    activeSession = next;
    this.emit();
  }
}

export const sessionBinding = new SessionBinding();

/** Version counter bumped whenever the SET of live sessions changes (a
 *  background session starts or dies, the active one switches). The rail
 *  re-resolves each record's OWN session through it — an inactive record's
 *  avatar mints and fetches via ITS session, not the active one's (a foreign
 *  rest client cannot mint another instance's object keys). */
class SessionsIndex extends Emitter {
  private version = 0;
  getSnapshot = (): number => this.version;
  bump = (): void => {
    this.version += 1;
    this.emit();
  };
}
export const sessionsIndex = new SessionsIndex();

/** The live session OWNING a record: the active one when it matches, else the
 *  record's background session, else null (dead tokens — disk-cache only). */
export function sessionForRecord(recordId: string): ConnectionSession | null {
  if (activeSession !== null && activeSession.recordId === recordId && !activeSession.isDisposed()) {
    return activeSession;
  }
  const background = sessionMap.get(recordId);
  return background !== undefined && !background.isDisposed() ? background : null;
}

/** Live voice-session objects — owned here, not per ConnectionSession (M4 moves them). */
let janusClient: JanusClient | null = null;
let sfuSession: SfuSession | null = null;
let localDisplayStream: MediaStream | null = null;
let localCameraStream: MediaStream | null = null;
let janusSessionLostFired = false;
let shareAudioElementActive = false;
/** The live noise-suppression detour over the RAW mic (a voice room XOR a call —
 *  the two are already exclusive). The raw track is kept so an engine switch can
 *  rebuild the detour and swap the published track without a re-capture. */
let activeNoisePipeline: NoisePipeline | null = null;
let noiseSourceTrack: MediaStreamTrack | null = null;
/** The DFN3 level the live pipeline was built with (only re-sends on change). */
let appliedDeepFilterLevel = -1;

/**
 * The server's voice-control verdict for OUR member — the compliance truth. Kept
 * OUTSIDE the SFU session so it survives the rejoin ladder (fresh tracks re-mute
 * themselves); reset only on a real leave (the server drops self-marks there,
 * moderator marks re-publish on re-entry anyway).
 */
const voiceCompliance = { micMuted: false, shareAudioMuted: false, deafened: false };

function applyComplianceToLiveSession(): void {
  sfuSession?.setMicEnabled(!voiceCompliance.micMuted);
  sfuSession?.setShareAudioEnabled(!voiceCompliance.shareAudioMuted);
  roomAudio.setDeafened(voiceCompliance.deafened);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Does a thread message mention ME (direct @user, held @role, unsuppressed @everyone)?
 *  The one mention formula shared with notifications.handleMessage, over the identity of
 *  THIS session — the discussion ACTIVITY path keys on it (the message rides the event). */
function mentionsIdentity(message: import("../types").Message, session: ConnectionSession | null): boolean {
  if (session === null) {
    return false;
  }
  const identity = selfIdentityFor(session);
  const suppress = notificationPrefsFor(session.recordId).suppressEveryoneHere;
  return messageMentionsUser(message.mentions, identity.userId)
    || messageMentionsRole(message.mentions, identity.roleIds)
    || (messageHasEveryoneHere(message.mentions) && !suppress);
}

/** The discussion mention/origin toast (title=actor, header=parent channel · discussion);
 *  the click opens the thread (switching instances when the event came from a background
 *  server). Shared by the origin-author first-reply ping and the plain mention path. */
function pingDiscussionEvent(
  recordId: string,
  session: ConnectionSession,
  event: import("../types").DiscussionEvent,
  body: string,
): void {
  const settings = settingsStore.getSnapshot();
  if (!settings.notificationsEnabled) {
    return;
  }
  const parentChannel = session.channelStore.get(event.parentChannelId);
  notifications.showToast({
    title: displayNameOf(session.rosterStore.getSnapshot().users, event.actorUsername),
    channelName: toastServerHeader(serverDisplayName(recordId),
      `#${parentChannel?.name ?? event.parentChannelId} · discussion`),
    body,
    mention: true,
    onClick: () => {
      const target = activeSession === session
        ? session.discussionsStore.byId(event.discussionId)
        : undefined;
      if (target !== undefined) {
        openDiscussion(target);
      } else {
        void openDiscussionOnInstance(recordId, event.discussionId);
      }
    },
  });
  if (settings.soundEnabled) {
    notifications.playBell();
  }
}

/** Loopback audio must arrive RAW. Without the explicit falses Chromium may run
 *  its audio processing over the desktop mix: the M0 stereo spike passed TONES
 *  through it, but the #483 subtraction spike measured the mangled broadband
 *  track — stable delay, correlation quality ~0.1, a ~3 dB cancellation
 *  ceiling. Applies to every loopback capture (shares, calls, self-tests). */
const LOOPBACK_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 2 },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

// ---------------------------------------------------------------------------
// Display-media self-test (risk probe from the spike)
// ---------------------------------------------------------------------------
export async function runDisplayMediaSelfTest(): Promise<void> {
  log.info("selftest", "getDisplayMedia({video:true, audio:{channelCount:{ideal:2}}})…");
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: LOOPBACK_AUDIO_CONSTRAINTS,
    });
    for (const track of stream.getTracks()) {
      const settings = track.getSettings();
      log.info("selftest",
        `track kind=${track.kind} label="${track.label}" channels=${settings.channelCount ?? "?"}`
        + ` rate=${settings.sampleRate ?? "?"} state=${track.readyState}`);
    }
    const audioTrack = stream.getAudioTracks()[0];
    log.info("selftest", audioTrack
      ? "SYSTEM AUDIO TRACK PRESENT — loopback works on this build"
      : "NO AUDIO TRACK — loopback unavailable on this build (video-only fallback)");
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch (error) {
    log.error("selftest", `getDisplayMedia failed: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Noise-engine self-test: deterministic white noise → engine → RMS verdict.
// No mic, no room, no peer — the engine's own worklet is the only variable,
// which is exactly what live reports could not isolate (identical code worked
// at one commit and failed at the next with nothing in between).
// ---------------------------------------------------------------------------

export async function runNoiseEngineSelfTest(engine: "rnnoise" | "deepfilternet3" | "speex" | "gate" | "dtln"): Promise<void> {
  const testContext = new AudioContext({ sampleRate: 48_000 });
  try {
    await testContext.resume();
    // Deterministic LCG white noise, ±0.25 amplitude, looped — the same signal
    // every run, so the verdict is comparable across launches.
    const noiseBuffer = testContext.createBuffer(1, 48_000 * 2, 48_000);
    const samples = noiseBuffer.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      samples[sampleIndex] = (seed / 0xffff_ffff - 0.5) * 0.5;
    }
    const generator = testContext.createBufferSource();
    generator.buffer = noiseBuffer;
    generator.loop = true;
    const generatorSink = testContext.createMediaStreamDestination();
    generator.connect(generatorSink);
    generator.start();
    const preAnalyser = testContext.createAnalyser();
    preAnalyser.fftSize = 2_048;
    generator.connect(preAnalyser);

    log.info("selftest", `noise engine ${engine}: building the pipeline…`);
    const generatorTrack = generatorSink.stream.getAudioTracks()[0];
    if (generatorTrack === undefined) {
      throw new Error("synthetic noise track missing");
    }
    const pipeline = await createNoisePipeline(engine, generatorTrack);
    const sink = testContext.createMediaStreamSource(new MediaStream([pipeline.track]));
    const postAnalyser = testContext.createAnalyser();
    postAnalyser.fftSize = 2_048;
    sink.connect(postAnalyser);

    await new Promise((resolve) => setTimeout(resolve, 1_500)); // let the engine process
    const preRms = peakRms(preAnalyser);
    const postRms = peakRms(postAnalyser);
    const verdict = postRms < preRms * 0.5
      ? "SUPPRESSED (engine works)"
      : postRms > preRms * 0.9
        ? "PASSTHROUGH (engine lets noise through — broken)"
        : "WEAK (some reduction, far short of RNNoise-class)";
    log.info("selftest", `noise engine ${engine}: in=${(preRms * 100).toFixed(1)}% out=${(postRms * 100).toFixed(1)}% → ${verdict}`);
    pipeline.dispose();
    generator.stop();
  } catch (error) {
    log.error("selftest", `noise engine ${engine} self-test failed: ${errorMessage(error)}`);
  } finally {
    void testContext.close();
  }
}

/** Max RMS across several analyser windows (~½ s) — robust to spot sampling. */
function peakRms(analyser: AnalyserNode): number {
  const buffer = new Float32Array(analyser.fftSize);
  let peak = 0;
  for (let windowIndex = 0; windowIndex < 8; windowIndex += 1) {
    analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
      sum += buffer[sampleIndex]! * buffer[sampleIndex]!;
    }
    peak = Math.max(peak, Math.sqrt(sum / buffer.length));
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Share-subtraction self-test (#483 spike): the honest end-to-end path —
// deterministic LCG noise goes through an <audio> ELEMENT (the exact playout
// route every remote track takes, the M0 lesson: the graph itself never plays),
// gets captured back by the desktop loopback, and the subtractor must cancel
// it. Verdict in dB per channel phase: L-only, R-only (catches channel swaps),
// then both. Keep the desktop otherwise silent for the ~9 s run.
// ---------------------------------------------------------------------------

let shareSubtractionTestRunning = false;

function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Two seconds of looping LCG noise per channel seed — same family as the NS test. */
function selfTestNoiseBuffer(context: AudioContext, seedValue: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 2), context.sampleRate);
  const samples = buffer.getChannelData(0);
  let seed = seedValue >>> 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    samples[sampleIndex] = (seed / 0xffff_ffff - 0.5) * 0.5;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Native system-audio self-test (#485 spike): WASAPI process-loopback, desktop
// minus OUR process — the OS-level exclude-self. Three phases: a silent
// desktop ≈ −∞; external audio alive; space's OWN sounds ≈ −∞ (the contract
// the failed DSP subtraction was chasing, granted by the OS instead).
// ---------------------------------------------------------------------------

let systemAudioTestRunning = false;
let monitorSource: SystemAudioSource | null = null;

function describeSystemAudioStats(source: SystemAudioSource): string {
  const stats = source.latestStats();
  if (stats === null) {
    return "no stats yet";
  }
  const left = rmsToDbfs(stats.rmsLeft);
  const right = rmsToDbfs(stats.rmsRight);
  return `L=${left <= -100 ? "−∞" : left.toFixed(1)} R=${right <= -100 ? "−∞" : right.toFixed(1)} dBFS`
    + ` underruns=${stats.underruns} dropped=${stats.dropped}`;
}

/** The local ear check: play the captured desktop-minus-us to our speakers
 *  (the loopback is a TAP — hearing the same audio twice is safe). With a
 *  native share running the monitor ATTACHES to its capture — a second source
 *  here would steal the share's IPC frame sink and fail main's single-session
 *  start, killing the share's audio. */
export async function toggleSystemAudioMonitor(): Promise<void> {
  if (isNativeShareActive()) {
    const next = !isShareMonitorWanted();
    monitorActiveShare(next);
    log.info("sysaudio", `monitor ${next ? "on" : "off"} (attached to the live share capture)`);
    return;
  }
  if (monitorSource !== null) {
    monitorSource.dispose();
    monitorSource = null;
    await window.spaceSysAudio?.stop();
    log.info("sysaudio", "monitor off");
    return;
  }
  const bridge = window.spaceSysAudio;
  if (!bridge || !(await bridge.available())) {
    log.info("sysaudio", "monitor unavailable — native capture not supported here");
    return;
  }
  const source = await createSystemAudioSource({ monitorSinkId: resolvedDevices.speaker });
  bridge.onFrame((pcm) => source.feed(pcm));
  if (!(await bridge.start())) {
    source.dispose();
    log.info("sysaudio", "monitor failed to start");
    return;
  }
  source.setMonitor(true);
  monitorSource = source;
  log.info("sysaudio", "monitor on — you hear the desktop WITHOUT this client");
}

/** A share starting while the STANDALONE monitor runs would orphan it (the
 *  share's acquire re-wires the single IPC sink) — wind it down first. */
async function stopStandaloneMonitorForShare(): Promise<void> {
  if (monitorSource !== null) {
    await toggleSystemAudioMonitor();
    log.info("sysaudio", "standalone monitor stopped for the share");
  }
}

export async function runSystemAudioSelfTest(): Promise<void> {
  if (systemAudioTestRunning) {
    return;
  }
  systemAudioTestRunning = true;
  try {
    const bridge = window.spaceSysAudio;
    if (!bridge) {
      throw new Error("bridge missing");
    }
    if (!(await bridge.available())) {
      log.info("selftest", "sysaudio: native capture unavailable (pre-2004 Windows or koffi absent)");
      return;
    }
    const source = await createSystemAudioSource();
    bridge.onFrame((pcm) => source.feed(pcm));
    if (!(await bridge.start())) {
      source.dispose();
      log.error("selftest", "sysaudio: capture failed to start");
      return;
    }
    log.info("selftest", "sysaudio capture live (48k stereo, exclude-self) — three phases, ~25 s total");
    await waitMs(2_000);
    const silentStats = source.latestStats();
    log.info("selftest", `sysaudio (a) baseline: ${describeSystemAudioStats(source)} — expect ≈−∞ on a silent desktop`);
    log.info("selftest", "sysaudio (b): START any music/video OUTSIDE space — window opens in 5 s");
    await waitMs(5_000);
    log.info("selftest", "sysaudio (b): WINDOW OPEN — keep it playing (5 s)");
    await waitMs(5_000);
    const externalStats = source.latestStats();
    log.info("selftest", `sysaudio (b) external audio: ${describeSystemAudioStats(source)} — expect alive`);
    log.info("selftest", "sysaudio (b): you may STOP the music now");
    log.info("selftest", "sysaudio (c): next — toggle MUTE 3-4 times (ONLY space sounds) — window opens in 5 s");
    await waitMs(5_000);
    log.info("selftest", "sysaudio (c): WINDOW OPEN — toggle mute now (5 s)");
    await waitMs(5_000);
    log.info("selftest", `sysaudio (c) space-only: ${describeSystemAudioStats(source)} — expect ≈−∞ (exclude-self contract)`);
    const externalAlive = externalStats !== null && (externalStats.rmsLeft > 0.005 || externalStats.rmsRight > 0.005);
    log.info("selftest",
      `sysaudio verdict: ${externalAlive ? "external audio captured" : "external audio NOT captured (was anything playing?)"}`
      + `, silent baseline ${silentStats === null ? "?" : rmsToDbfs(Math.max(silentStats.rmsLeft, silentStats.rmsRight)).toFixed(1) + " dBFS"}`);
    await bridge.stop();
    source.dispose();
  } catch (error) {
    log.error("selftest", `sysaudio self-test failed: ${errorMessage(error)}`);
  } finally {
    systemAudioTestRunning = false;
  }
}

export async function runShareSubtractionSelfTest(): Promise<void> {
  if (shareSubtractionTestRunning) {
    log.info("selftest", "share-subtract: already running");
    return;
  }
  shareSubtractionTestRunning = true;
  log.info("selftest", "share-subtract: starting — keep the desktop otherwise SILENT for ~13 s");
  let context: AudioContext | null = null;
  let subtraction: Awaited<ReturnType<typeof createShareSubtraction>> | null = null;
  let desktop: MediaStream | null = null;
  let playoutElement: HTMLAudioElement | null = null;
  try {
    const listed = await window.spaceCapture?.sources(["screen"]); // screens only — no window enumeration
    const screen = (listed ?? []).find((source) => source.kind === "screen");
    if (!screen) {
      throw new Error("no screen source — loopback capture impossible");
    }
    await window.spaceCapture?.select(screen.id, true); // arm the grant with audio
    desktop = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: LOOPBACK_AUDIO_CONSTRAINTS,
    });
    const loopbackTrack = desktop.getAudioTracks()[0];
    if (loopbackTrack === undefined) {
      throw new Error("no loopback audio track came back (grant without sound)");
    }
    for (const videoTrack of desktop.getVideoTracks()) {
      videoTrack.stop(); // audio is all the spike needs
    }
    const settings = loopbackTrack.getSettings();
    log.info("selftest", `share-subtract: loopback ch=${settings.channelCount ?? "?"} rate=${settings.sampleRate ?? "?"}`);

    // Generator graph: two looping noise sources → L/R gains → merger → the
    // playout track (an <audio> element, the REAL route to the OS) and the
    // subtractor's reference input (the same node tap — bit-exact reference).
    context = new AudioContext();
    await context.resume();
    const leftSource = context.createBufferSource();
    leftSource.buffer = selfTestNoiseBuffer(context, 0x2f6e2b1);
    leftSource.loop = true;
    const rightSource = context.createBufferSource();
    rightSource.buffer = selfTestNoiseBuffer(context, 0x71a3c9d);
    rightSource.loop = true;
    const leftGain = context.createGain();
    leftGain.gain.value = 0;
    const rightGain = context.createGain();
    rightGain.gain.value = 0;
    const merger = context.createChannelMerger(2);
    leftSource.connect(leftGain).connect(merger, 0, 0);
    rightSource.connect(rightGain).connect(merger, 0, 1);
    const testMix = context.createGain();
    merger.connect(testMix);
    const playoutSink = context.createMediaStreamDestination();
    testMix.connect(playoutSink);
    playoutElement = new Audio();
    playoutElement.autoplay = true;
    playoutElement.srcObject = playoutSink.stream;
    await playoutElement.play();
    leftSource.start();
    rightSource.start();

    subtraction = await createShareSubtraction(loopbackTrack, { elements: [testMix], contexts: [] }, context);

    const formatLags = (history: { lag: number }[] | undefined): string =>
      (history ?? []).map((entry) => entry.lag).join("/");

    // Path gain: loopback energy over reference energy — if the loopback is
    // dominated by something OTHER than our signal, this reads far above the
    // plausible device gain and points the search off the processing path.
    const pathGainDb = (channels: { loopbackSquareSum: number }[], domainReference: number): string => {
      let loopbackSquare = 0;
      for (const channel of channels) {
        loopbackSquare += channel.loopbackSquareSum;
      }
      if (domainReference <= 1e-12) {
        return "?";
      }
      return (10 * Math.log10(loopbackSquare / domainReference)).toFixed(1);
    };

    const runPhase = async (label: string, left: number, right: number): Promise<number | null> => {
      leftGain.gain.value = left;
      rightGain.gain.value = right;
      await waitMs(1_000); // fill the correlation buffer + let the NLMS converge
      await subtraction!.readStats(); // dropped — resets the measurement window
      await waitMs(1_200); // the measurement window
      const stats = await subtraction!.readStats();
      const decibels = suppressionDb(stats);
      const elements = stats.domains[0];
      log.info("selftest",
        `share-subtract ${label}: ${decibels === null ? "NO SIGNAL in loopback (speakers muted?)" : decibels.toFixed(1) + " dB"}`
        + ` — delay ${elements?.delaySamples ?? "?"} ${elements?.locked ? "locked" : "searching"}`
        + ` quality ${(elements?.correlationQuality ?? 0).toFixed(2)}`
        + ` gain ${pathGainDb(stats.channels, elements?.referenceSquareSum ?? 0)} dB`
        + ` lags=[${formatLags(elements?.lagHistory)}]`);
      leftGain.gain.value = 0;
      rightGain.gain.value = 0;
      await waitMs(300); // silence gap — also exercises the reference-silence gate
      return decibels;
    };

    const phaseResults = [
      await runPhase("L-only", 1, 0),
      await runPhase("R-only", 0, 1),
      await runPhase("stereo", 1, 1),
    ];

    // Voice-likeness regression — THE live-smoke bug class (2026-09-18): speech
    // is quasi-periodic and its correlation multi-peaked, which made the old
    // global-max tracker jump pitch aliases. Pitch-modulated noise reproduces
    // the multi-peak structure; the tracker must hold ONE delay (no ±240–480
    // jumps) and still cancel. Logged separately, not part of the verdict.
    const voiceLeftGain = context!.createGain();
    voiceLeftGain.gain.value = 0;
    const voiceRightGain = context!.createGain();
    voiceRightGain.gain.value = 0;
    voiceLeftGain.connect(merger, 0, 0);
    voiceRightGain.connect(merger, 0, 1);
    const makeVoiceSource = (seedValue: number): AudioBufferSourceNode => {
      const buffer = context!.createBuffer(1, Math.floor(context!.sampleRate * 2), context!.sampleRate);
      buffer.getChannelData(0).set(modulatedNoise(buffer.length, seedValue, 150, context!.sampleRate));
      const source = context!.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.start();
      return source;
    };
    makeVoiceSource(0x51ed29b).connect(voiceLeftGain);
    makeVoiceSource(0x2c7a4f1).connect(voiceRightGain);
    voiceLeftGain.gain.value = 1;
    voiceRightGain.gain.value = 1;
    await waitMs(1_000);
    await subtraction.readStats();
    await waitMs(1_200);
    const voiceStats = await subtraction.readStats();
    const voiceDecibels = suppressionDb(voiceStats);
    const voiceElements = voiceStats.domains[0];
    const recentLags = (voiceElements?.lagHistory ?? []).slice(-4).map((entry) => entry.lag);
    const lagSpread = recentLags.length > 0 ? Math.max(...recentLags) - Math.min(...recentLags) : 0;
    log.info("selftest",
      `share-subtract voice-like (multi-peak regression): ${voiceDecibels === null ? "NO SIGNAL" : voiceDecibels.toFixed(1) + " dB"}`
      + ` — delay ${voiceElements?.delaySamples ?? "?"} ${voiceElements?.locked ? "locked" : "searching"}`
      + ` lags=[${formatLags(voiceElements?.lagHistory)}] → ${lagSpread <= 16 ? "STABLE" : "JUMPING (alias chase — the smoke bug is back)"}`);
    voiceLeftGain.gain.value = 0;
    voiceRightGain.gain.value = 0;
    const measured = phaseResults.filter((value): value is number => value !== null);
    if (measured.length === 0) {
      log.error("selftest", "share-subtract: no phase produced a loopback signal — check output device/volume");
    } else {
      const worst = Math.min(...measured);
      const verdict = worst >= 20
        ? "SUPPRESSED (own playout is cancellable from loopback — production round is viable)"
        : worst >= 8
          ? "PARTIAL (path not purely linear — check OS audio enhancements / spatial sound)"
          : "FAILED (subtraction does not converge)";
      log.info("selftest", `share-subtract verdict: worst phase ${worst.toFixed(1)} dB → ${verdict}`);
    }
  } catch (error) {
    log.error("selftest", `share-subtract self-test failed: ${errorMessage(error)}`);
  } finally {
    try {
      playoutElement?.pause();
      if (playoutElement !== null) {
        playoutElement.srcObject = null;
      }
      subtraction?.dispose();
      desktop?.getTracks().forEach((track) => track.stop());
    } finally {
      if (context !== null) {
        void context.close().catch(() => undefined);
      }
      shareSubtractionTestRunning = false;
      log.info("selftest", "share-subtract: teardown complete");
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle: bootstrap → login/resume → open → teardown
// ---------------------------------------------------------------------------

/**
 * Per-record hooks (oak phase 2): every session — the ACTIVE one and each
 * BACKGROUND one — gets its own hook set. The `isActive()` gate keeps global
 * UI state (connection status, voice, calls, channel routing) owned by the
 * active session alone; background sessions only feed their OWN stores, the
 * aggregated badges and (with their record's prefs) toasts.
 */
function makeSessionHooks(recordId: string): SessionHooks {
  const isActive = (): boolean => activeSession?.recordId === recordId;
  return {
    onSessionExpired: (expiredRecordId) => {
      if (!isActive()) {
        // A background family died — drop that session quietly; the REST
        // fallback cannot cover it either (same tokens), the rows just leave.
        log.warn("app", `background session expired (record ${expiredRecordId}) — dropping`);
        disposeBackgroundSession(expiredRecordId);
        return;
      }
      log.warn("app", `session expired (record ${expiredRecordId}) — back to login`);
      void teardownSession();
      openLoginForm({ loginError: "Session expired — log in again" });
      appStore.patch({ userSettingsOpen: false });
    },
    onStompState: (state) => {
      if (isActive()) {
        appStore.patch({
          stompState: state,
          ...(state === "connected" ? { stompAttempt: 0, stompCountdown: null } : {}),
        });
      }
    },
    onConnectionQuality: (snapshot) => {
      if (isActive()) {
        // The ACTIVE session's indicator only — a background server's ping
        // must never repaint the visible user bar.
        appStore.patch({ connectionQuality: snapshot });
      }
    },
    onStompAttempt: (attempt) => {
      if (isActive()) {
        appStore.patch({ stompState: "connecting", stompAttempt: attempt, stompCountdown: null });
      }
    },
    onStompCountdown: (secondsLeft, attempt) => {
      if (isActive()) {
        appStore.patch({ stompState: "connecting", stompAttempt: attempt, stompCountdown: secondsLeft });
      }
    },
    onStompExhausted: () => {
      if (isActive()) {
        appStore.patch({ stompState: "lost", stompAttempt: 0, stompCountdown: null });
        return;
      }
      // A background server's ladder restarts QUIETLY from zero (oak's
      // per-session reconnect loops forever off-screen); the 30 s pause keeps
      // a dead server from being probed in a tight 10-attempt cycle.
      window.setTimeout(() => {
        const background = sessionMap.get(recordId);
        if (background !== undefined && !background.isDisposed() && !background.stomp.isConnected()) {
          background.stomp.reconnectNow();
        }
      }, 30_000);
    },
    onStompConnected: () => {
      if (!isActive()) {
        return; // the voice re-announce belongs to the ACTIVE session's socket only
      }
      const channelId = appStore.getSnapshot().activeVoiceChannelId;
      if (channelId !== null) {
        activeSession?.stomp.send("/app/voice.join", { channelId });
      }
      // A live call re-announces its media state: the one-shot MIC/CAM/SCREEN/
      // DEAFEN signals sent while the socket was down were silently dropped.
      callSession?.reannounceState();
    },
    onChannelGone: (channelId) => {
      if (!isActive()) {
        return; // the background session's own stores already forgot the channel
      }
      if (appStore.getSnapshot().activeChannelId === channelId) {
        pickFallbackTextChannel();
      }
      if (appStore.getSnapshot().activeVoiceChannelId === channelId) {
        void leaveVoice();
      }
    },
    onChannelsChanged: () => {
      if (isActive()) {
        ensureActiveChannelExists();
      }
    },
    onLiveMessage: (message) => {
      const session = sessionMap.get(recordId) ?? activeSession;
      const recordUsername = connectionDirectory.get(recordId)?.username ?? "?";
      if (!session) {
        return;
      }
      const dm = session.socialStore.getDm(message.channelId);
      const channel = dm === null ? session.channelStore.get(message.channelId) : null;
      if (dm === null && channel === null) {
        return; // a channel we closed/left — a frame still in flight after the unsubscribe
      }
      // One's OWN message must never count as unread or ring the bell. It can
      // still reach this hook: sent into a channel whose history hadn't loaded
      // yet (fresh switch), the REST echo is dropped by the store and the STOMP
      // echo later arrives as an "insert" (live report: a DM sent right after
      // switching to an inactive server raised a mention toast for the sender).
      const ownMessage = message.authorUsername === recordUsername;
      const settings = settingsStore.getSnapshot();
      const serverPrefs = notificationPrefsFor(recordId);
      if (isActive()) {
        const state = appStore.getSnapshot();
        // A channel is "open" only when its view is actually ON SCREEN: in Home
        // mode the server channel is not displayed (its id merely survives the
        // round-trip) — treating it as open swallowed mention toasts while the
        // user sat in Friends (oak nulls selectedChannelId on enterDmMode).
        const inOpenChannel = (dm !== null
          ? state.dmMode && state.activeDmId === message.channelId
          : !state.dmMode && state.activeChannelId === message.channelId);
        const windowFocused = document.hasFocus();
        const self = selfIdentityFor(session);
        // DM rule: EVERY direct message is a mention equivalent (oak parity) — the
        // badge is red and the bell rings even without an @. suppressEveryoneHere
        // keeps an @everyone ping out of the red counter (it still counts unread).
        // The counters ALWAYS move (oak gates only the badge RENDER) — hiding them
        // must not freeze the unread state for when they come back on.
        if (!ownMessage) {
          session.readStateStore.bumpLive(
            message,
            self,
            inOpenChannel,
            windowFocused,
            dm !== null,
            !serverPrefs.suppressEveryoneHere,
          );
        }
        if (dm !== null) {
          // float the row + refresh the preview (author's DISPLAY name — the login never renders)
          session.socialStore.updateDmLastMessage(
            message,
            displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
          );
        }
        if (ownMessage || (inOpenChannel && windowFocused)) {
          return;
        }
        // oak's toast header: "Server  #channel" for server channels; a DM group
        // shows its name, a 1:1 shows none (the author line is the peer already).
        const channelName = dm !== null
          ? dmToastHeader("", dm, dmDisplayName(dm, recordUsername))
          : toastServerHeader(serverDisplayName(recordId), channel !== null ? `#${channel.name}` : `#${message.channelId}`);
        notifications.handleMessage(
          message,
          self,
          channelName,
          windowFocused,
          inOpenChannel,
          {
            serverMode: serverPrefs.mode,
            suppressEveryoneHere: serverPrefs.suppressEveryoneHere,
            notificationsEnabled: settings.notificationsEnabled,
            soundEnabled: settings.soundEnabled,
          },
          dm !== null ? () => openDm(dm.id) : () => setActiveChannel(message.channelId),
          dm !== null, // every DM is a mention equivalent
          displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
        );
        return;
      }
      // BACKGROUND instance (oak's evaluateNotification for non-active cids):
      // the message is never "open on screen" — bump that instance's counters,
      // float its DM row, and toast with ITS prefs; the click switches there.
      if (!ownMessage) { // counters always move (oak); badgeEnabled only gates the render
        session.readStateStore.bumpLive(
          message,
          selfIdentityFor(session),
          false,
          false,
          dm !== null,
          !serverPrefs.suppressEveryoneHere,
        );
      }
      if (dm !== null) {
        session.socialStore.updateDmLastMessage(
          message,
          displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
        );
      }
      if (ownMessage) {
        return;
      }
      // Same oak header shapes, but the instance is NOT the active one — its
      // server name tags the toast so the user sees where the message came from.
      const channelName = dm !== null
        ? dmToastHeader(serverDisplayName(recordId), dm, dmDisplayName(dm, recordUsername))
        : toastServerHeader(serverDisplayName(recordId), channel !== null ? `#${channel.name}` : `#${message.channelId}`);
      notifications.handleMessage(
        message,
        selfIdentityFor(session),
        channelName,
        false,
        false,
        {
          serverMode: serverPrefs.mode,
          suppressEveryoneHere: serverPrefs.suppressEveryoneHere,
          notificationsEnabled: settings.notificationsEnabled,
          soundEnabled: settings.soundEnabled,
        },
        dm !== null ? () => openDmOnInstance(recordId, dm.id) : () => openChannelOnInstance(recordId, message.channelId),
        dm !== null,
        displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
      );
    },
    onVoiceMemberEvent: (event) => {
      // The OTHERS' knock (user request 2026-09-21): someone joining or
      // leaving the room I am in knocks for me too (Discord semantics — the
      // room talks even when my own feet are still). Own transitions already
      // knock at the join/leave site; other channels are not my business.
      if (!isActive()) {
        return; // only the active session is ever in voice
      }
      const state = appStore.getSnapshot();
      if (event.channelId !== state.activeVoiceChannelId || event.username === state.ownUsername) {
        return;
      }
      if (settingsStore.getSnapshot().soundEnabled) {
        notifications.playKnock(event.status === "JOINED" ? "join" : "leave");
      }
    },
    onOwnVoiceControlState: (state) => {
      if (!isActive()) {
        return; // only the active session is ever in voice
      }
      // The union drives our mic and our speakers; ONLY a moderator mute cuts the
      // share audio too (a self-mute must leave the music playing — Discord semantics).
      voiceCompliance.micMuted = state.muted;
      voiceCompliance.shareAudioMuted = state.modMuted;
      voiceCompliance.deafened = state.deafened;
      applyComplianceToLiveSession();
      pushPopoutVoiceState(); // the pop-out's mirrored voice-panel buttons follow
      log.info("voice", `compliance: mic=${state.muted ? "muted" : "open"} (self=${state.selfMuted} mod=${state.modMuted})`
        + ` deafened=${state.deafened} shareAudio=${state.modMuted ? "muted" : "open"}`);
    },
    onVoiceKicked: (byUsername) => {
      if (!isActive()) {
        return;
      }
      cancelVoiceRejoin();
      void leaveVoice();
      notifications.showToast({ title: "Voice", channelName: byUsername, body: "You were kicked from the voice channel." });
    },
    onVoiceMoved: (channelId) => {
      // The AFK sweep (only the active session is ever in voice). The membership
      // already moved server-side; a rejoin ladder targeting the OLD room must die,
      // and the new channel is re-joined through the ordinary join path (its own
      // cancelVoiceRejoin + fresh /room). Unavailable/locked → out of voice.
      if (!isActive()) {
        return;
      }
      cancelVoiceRejoin();
      const session = activeSession;
      const channel = session !== null ? session.channelStore.get(channelId) : null;
      if (channel === null || channel.type !== "VOICE" || channel.locked) {
        void leaveVoice();
        return;
      }
      notifications.showToast({ title: "Voice", channelName: channel.name, body: `You were moved to #${channel.name}` });
      void joinVoice(channel);
    },
    onCallSignal: (signal) => {
      if (isActive()) {
        handleCallSignal(signal);
        return;
      }
      // BACKGROUND ring (#475): the same toast-window call card, tagged with the
      // background server's name; busy auto-rejects (oak). Accept switches the
      // instance first (openSession consumes pendingBackgroundAccept).
      if (signal.type === "RING") {
        if (appStore.getSnapshot().callState !== "idle" || backgroundRing !== null) {
          sessionMap.get(recordId)?.sendCallSignal({ type: "REJECT", to: signal.from, sdp: null, candidate: null });
          return;
        }
        const ring = { recordId, peer: signal.from, timer: null as number | null };
        backgroundRing = ring;
        const session = sessionMap.get(recordId) ?? null;
        if (session !== null) {
          showIncomingCallCard(session, signal.from);
          notifications.playChime();
        }
        const timeoutSeconds = settingsStore.getSnapshot().ringTimeoutSeconds;
        if (timeoutSeconds > 0) {
          ring.timer = window.setTimeout(() => {
            if (backgroundRing === ring) {
              clearBackgroundRing(); // missed — the caller's own timeout sends HANGUP
            }
          }, timeoutSeconds * 1000);
        }
        log.info("call", `background RING from ${signal.from} on record ${recordId}`);
        return;
      }
      if (signal.type === "HANGUP"
        && backgroundRing !== null
        && backgroundRing.recordId === recordId
        && backgroundRing.peer === signal.from) {
        clearBackgroundRing();
      }
    },
    onDmClosed: (channelId) => {
      if (isActive() && appStore.getSnapshot().activeDmId === channelId) {
        appStore.patch({ activeDmId: null }); // back to the Friends pane
      }
    },
    onVoiceInvite: (invite) => {
      // Both the ACTIVE and a BACKGROUND session surface the same card (the
      // record tag rides the map entry — Join knows where to switch); a light
      // bell under the sound switch (this is a nudge, not a call chime).
      log.info("voice-invite", `incoming from ${invite.from} to #${invite.channelName} (record ${recordId})`);
      // The onCallSignal lesson: the ACTIVE session is NOT in sessionMap (the
      // promote path deletes it — it lives in activeSession); a map-only lookup
      // silently dropped every invite of the on-screen record (live report).
      const inviteSession = isActive() ? activeSession : sessionMap.get(recordId) ?? null;
      if (inviteSession === null) {
        log.warn("voice-invite", `no session for record ${recordId} — card dropped`);
        return;
      }
      showVoiceInviteCard(inviteSession, invite);
      if (settingsStore.getSnapshot().soundEnabled) {
        notifications.playBell();
      }
    },
    onDiscussionEvent: (event) => {
      if (!isActive()) {
        // Background instance: only the MENTION path matters there (the thread pinged me);
        // lifecycle cosmetics (close kicks, origin pings) belong to the instance on screen.
        const backgroundSession = sessionMap.get(recordId);
        if (backgroundSession === undefined) {
          return;
        }
        if (event.type === "ACTIVITY" && event.discussion !== null && event.message !== null
            && event.message.authorUsername !== (connectionDirectory.get(recordId)?.username ?? "?")
            && mentionsIdentity(event.message, backgroundSession)) {
          backgroundSession.discussionsStore.setTracked(event.discussionId, true); // server auto-joined me
          const parentChannel = backgroundSession.channelStore.get(event.discussion.parentChannelId);
          const settings = settingsStore.getSnapshot();
          if (settings.notificationsEnabled) {
            notifications.showToast({
              title: displayNameOf(backgroundSession.rosterStore.getSnapshot().users, event.message.authorUsername),
              channelName: toastServerHeader(serverDisplayName(recordId),
                `#${parentChannel?.name ?? event.discussion.parentChannelId} · discussion`),
              body: toastBodyFallback(event.message),
              mention: true,
              onClick: () => {
                void openDiscussionOnInstance(recordId, event.discussionId);
              },
            });
            if (settings.soundEnabled) {
              notifications.playBell();
            }
          }
        }
        return;
      }
      // REMOVED is the only close signal: a view open on the closed thread kicks back to
      // the parent channel (the store already purged the row; the toast explains why).
      if (event.type === "REMOVED") {
        if (appStore.getSnapshot().activeDiscussion?.discussionId === event.discussionId) {
          closeDiscussionView();
          notifications.showToast({ title: "space", channelName: "", body: "Discussion was closed" });
        }
        return;
      }
      if (event.type !== "ACTIVITY" || event.discussion === null) {
        return;
      }
      const session = sessionMap.get(recordId) ?? activeSession;
      if (session === null) {
        return;
      }
      // The user rule: the FIRST reply into a thread on MY message behaves like a mention —
      // the thread is already in my tracked list (the server auto-joined the origin author
      // at creation); the ping fires once, from the actor the event carries.
      const selfId = session.selfUserId();
      if (event.replyCount === 1 && selfId !== null && event.discussion.originAuthorId === selfId
          && event.actorUsername !== session.username()
          && appStore.getSnapshot().activeDiscussion?.discussionId !== event.discussionId) {
        session.discussionsStore.setTracked(event.discussionId, true); // server did; mirror now
        pingDiscussionEvent(recordId, session, event, "replied in a discussion on your message");
        return;
      }
      // The mention path (user rule): a thread message that @mentions me subscribes me
      // (server-side already) and pings — even though I never subscribed to the thread's
      // own topic; the message rides the event for exactly this. Skipped while the thread
      // is open on screen (the live-message hook owns that case).
      if (event.message !== null
          && event.message.authorUsername !== session.username()
          && appStore.getSnapshot().activeDiscussion?.discussionId !== event.discussionId
          && mentionsIdentity(event.message, session)) {
        session.discussionsStore.setTracked(event.discussionId, true); // server auto-joined me
        pingDiscussionEvent(recordId, session, event, toastBodyFallback(event.message));
      }
    },
    onDiscussionLiveMessage: (message) => {
      const session = sessionMap.get(recordId) ?? activeSession;
      if (!session || !isActive()) {
        return; // only the active session ever holds an open discussion subscription
      }
      const recordUsername = connectionDirectory.get(recordId)?.username ?? "?";
      if (message.authorUsername === recordUsername) {
        return; // one's own message never pings
      }
      const discussion = session.discussionsStore.byId(message.channelId);
      if (discussion === undefined) {
        return; // an unknown thread — no context to render (and none we track)
      }
      const settings = settingsStore.getSnapshot();
      const serverPrefs = notificationPrefsFor(recordId);
      const openOnScreen = appStore.getSnapshot().activeDiscussion?.discussionId === message.channelId;
      const parentChannel = session.channelStore.get(discussion.parentChannelId);
      notifications.handleMessage(
        message,
        selfIdentityFor(session),
        toastServerHeader(serverDisplayName(recordId),
          `#${parentChannel?.name ?? discussion.parentChannelId} · discussion`),
        document.hasFocus(),
        openOnScreen,
        {
          // MENTIONS floor even when the server says ALL: a tracked thread must NOT toast
          // on every message — only the mention path may fire (decider: non-mention → none).
          serverMode: serverPrefs.mode === "ALL" ? "MENTIONS" : serverPrefs.mode,
          suppressEveryoneHere: serverPrefs.suppressEveryoneHere,
          notificationsEnabled: settings.notificationsEnabled,
          soundEnabled: settings.soundEnabled,
        },
        () => {
          const row = session.discussionsStore.byId(message.channelId);
          if (row !== undefined) {
            openDiscussion(row);
          }
        },
        false,
        displayNameOf(session.rosterStore.getSnapshot().users, message.authorUsername),
      );
    },
    onMemberKicked: (event) => {
      const reason = memberKickReasonText(event);
      const title = memberKickTitle(event);
      if (!isActive()) {
        log.warn("app", `${event.removed ? "removed" : event.banned ? "banned" : "kicked"} on a background server (record ${recordId}) — dropping the session`);
        disposeBackgroundSession(recordId);
        notifications.showToast({ title, channelName: event.by, body: reason });
        return;
      }
      // A REMOVAL/BAN kills the tokens at the REST layer; a plain disconnect keeps
      // them — dropping to the login modal covers both (the removed/banned branch
      // just answers 401/403 instead of reconnecting), oak's ErrorDialog parity.
      const record = connectionDirectory.get(recordId);
      void teardownSession().finally(() => {
        openLoginForm({
          loginError: reason,
          loginPrefill: record !== null ? { url: record.hostUrl, username: record.username } : null,
        });
        appStore.patch({ userSettingsOpen: false });
        notifications.showToast({ title, channelName: event.by, body: reason });
      });
    },
    onOwnershipEvent: (event) => {
      log.info("ownership", `transfer ${event.transfer.id} ${event.type} (from=${event.transfer.fromUsername} to=${event.transfer.toUsername})`);
      // The banner/permissions flip rides the pending refetch; the one thing worth
      // celebrating out loud is BECOMING the owner (this record's login = the wire's
      // `to` — the hooks factory has no session, the record carries the username).
      if (event.type === "ACCEPTED"
        && event.transfer.toUsername === connectionDirectory.get(recordId)?.username) {
        notifications.showToast({ title: "Server", channelName: "", body: "You are now the owner of this server." });
      }
    },
  };
}

/** Resolved device picks: Chromium's deviceId hashes do NOT survive app
 *  restarts here (every voice join used to log "saved microphone unavailable"),
 *  so the saved (id, label) pair re-resolves against a live enumeration — exact
 *  id first, label fallback (domain/logic/device-match.ts). Refreshed on Apply
 *  and on hotplug. */
const resolvedDevices = { microphone: null as string | null, speaker: null as string | null, camera: null as string | null };

async function resolveSavedDevices(): Promise<void> {
  const settings = settingsStore.getSnapshot();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.every((device) => device.deviceId.length === 0)) {
      return; // pre-permission enumeration — nothing to resolve against yet
    }
    resolvedDevices.microphone = matchDeviceId(
      devices.filter((device) => device.kind === "audioinput"),
      settings.microphoneDeviceId,
      settings.microphoneLabel,
    );
    resolvedDevices.speaker = matchDeviceId(
      devices.filter((device) => device.kind === "audiooutput"),
      settings.speakerDeviceId,
      settings.speakerLabel,
    );
    resolvedDevices.camera = matchDeviceId(
      devices.filter((device) => device.kind === "videoinput"),
      settings.cameraDeviceId,
      settings.cameraLabel,
    );
  } catch {
    // keep the previous resolution
  }
}

function watchDeviceSettings(): void {
  let appliedKey = "";
  const update = (): void => {
    void resolveSavedDevices().then(() => {
      const key = JSON.stringify(resolvedDevices);
      if (key === appliedKey) {
        return;
      }
      appliedKey = key;
      // The speaker follows the RESOLVED device (the saved hash may be stale).
      roomAudio.setOutputDevice(resolvedDevices.speaker);
      notifications.setOutputDevice(resolvedDevices.speaker);
      setActiveShareMonitorSink(resolvedDevices.speaker); // the diag monitor ear rides along
    });
  };
  settingsStore.subscribe(update); // Apply re-resolves (a fresh hash was just saved)
  navigator.mediaDevices.addEventListener("devicechange", update); // hotplug / late labels
  update();
}

// ---------------------------------------------------------------------------
// Boot auto-resume ladder (a network-dead server at startup)
// ---------------------------------------------------------------------------

/** Set while the boot ladder owns a record: openSession failed on a NETWORK
 *  error (the tokens are fine, the server is simply not answering), and the
 *  client keeps retrying quietly — fast at first, then every 30 s forever — so
 *  it snaps on the moment the server appears, with no manual rail click (live
 *  report: the client sat dead on the empty screen even after the server came
 *  up). Unlike the mid-session STOMP ladder this one never goes terminal: the
 *  empty screen has no ↻ affordance, and "the server is not started yet" can
 *  take arbitrarily long. Any user action that produces a session (login, rail
 *  switch) or a dead token family stops it. Also EXCLUDES the record from
 *  startBackgroundSessions — a background start racing the ladder could be
 *  PROMOTED half-started by openSession. */
let bootResumeRecordId: string | null = null;
let bootResumeAttempt = 0;
let bootResumeTimer: number | null = null;

function scheduleBootResume(recordId: string, delaySeconds: number): void {
  if (bootResumeTimer !== null) {
    return; // one ladder, one timer
  }
  bootResumeTimer = window.setTimeout(() => {
    bootResumeTimer = null;
    void retryBootResume(recordId);
  }, delaySeconds * 1000);
}

/** Boot-ladder attempts keep the "Connecting…" paint for this many tries; after
 *  that the empty screen switches to the honest offline wording (the ladder
 *  itself keeps retrying in the background — it just stops PRETENDING). */
const BOOT_CONNECTING_ATTEMPTS = 2;

async function retryBootResume(recordId: string): Promise<void> {
  const record = connectionDirectory.get(recordId);
  if (!record || activeSession !== null || record.token === EXPIRED_MARKER || record.refreshToken === "") {
    // The user acted (a session is live), the record is gone, or its token
    // family died mid-ladder (the login modal is already up). Stand down —
    // a live session owns stompState, only clear what we painted ourselves.
    if (appStore.getSnapshot().bootRetryNotice !== null) {
      appStore.patch({ bootRetryNotice: null }); // never outlives the ladder
    }
    if (activeSession === null && appStore.getSnapshot().stompState === "connecting") {
      appStore.patch({ stompState: "off" });
    }
    bootResumeRecordId = null;
    // The record is no longer ladder-owned — give it its background pass (it
    // was excluded from startBackgroundSessions while we held it).
    startBackgroundSessions();
    return;
  }
  bootResumeAttempt += 1;
  try {
    // The cheap reachability probe first: a dead server fails in milliseconds
    // instead of paying a full session bootstrap with its REST retry chains.
    await probeServerReachable(record.hostUrl);
    await openSession(recordId);
    log.info("app", `auto-resumed ${record.username} @ ${record.hostUrl} (boot attempt ${bootResumeAttempt})`);
    bootResumeRecordId = null;
    appStore.patch({ bootRetryNotice: null }); // the offline wording must not outlive the outage
    return; // connected — openSession took it from here
  } catch (error) {
    log.info("app", `boot resume attempt ${bootResumeAttempt} failed (${errorMessage(error)})`);
  }
  if (!connectionDirectory.get(recordId)) {
    bootResumeRecordId = null;
    return; // removed while the attempt was flying
  }
  // stompState was reset to "off" by teardownSession inside the failed attempt.
  // The first few attempts repaint "connecting" (the screen says we are still
  // reaching out); past that, keep the honest offline wording — an eternal
  // "Connecting…" reads as a freeze (user report 2026-10-08).
  if (bootResumeAttempt <= BOOT_CONNECTING_ATTEMPTS) {
    appStore.patch({ stompState: "connecting" });
  } else if (appStore.getSnapshot().bootRetryNotice === null) {
    appStore.patch({
      stompState: "lost",
      bootRetryNotice: record.cachedServerName ?? record.hostUrl,
    });
  }
  scheduleBootResume(recordId, Math.min(2 ** bootResumeAttempt, 30));
}

/** App entry: load the directory, auto-resume the most recently used connection. */
export async function bootstrapApp(): Promise<void> {
  await settingsStore.load();
  watchNoiseSettings(); // an engine pick rebuilds the detour while voice/call is live
  watchDeviceSettings(); // device picks re-resolve (hashes die across restarts)
  installHotkeys(); // global OS chords + the window keydown (local binds)
  installSourceDeadListener(); // the window-share liveness watchdog reports here
  installPopoutClosedListener(); // the share pop-out's own close lands here
  installTlsPromptListener(); // untrusted server certificates ask for trust here
  installPopoutVolumeListener(); // the share pop-out's volume slider lands here
  installPopoutVoiceActionListener(); // the pop-out's mirrored voice-panel buttons land here
  installAppClosingListener(); // the forestalled window close leaves voice/call cleanly
  settingsStore.subscribe(pushPopoutVoiceState); // an NS engine flip recolors the pop-out's button
  pushPopoutVoiceState(); // the initial mirror (the pop-out reads it on mount)
  notifications.setToastConfig({
    dismissSeconds: () => settingsStore.getSnapshot().toastDismissSeconds,
    maxToasts: () => settingsStore.getSnapshot().maxToasts,
  });
  await connectionDirectory.loadAll();
  const newest = connectionDirectory.getSnapshot()[0];
  if (newest && newest.refreshToken !== "" && newest.token !== EXPIRED_MARKER) {
    try {
      await openSession(newest.id);
      log.info("app", `auto-resumed ${newest.username} @ ${newest.hostUrl}`);
    } catch (error) {
      const record = connectionDirectory.get(newest.id);
      if (record && record.token !== EXPIRED_MARKER && record.refreshToken !== "") {
        // A NETWORK failure (server down): the family is alive, keep reaching
        // out in the background instead of sitting dead until a rail click.
        log.info("app", `auto-resume failed (${errorMessage(error)}) — boot retry ladder armed`);
        bootResumeRecordId = newest.id;
        appStore.patch({ stompState: "connecting" });
        scheduleBootResume(newest.id, 2);
      } else {
        log.info("app", `auto-resume failed (${errorMessage(error)}) — login screen`);
      }
    }
  }
  // Every other record comes up as a LIVE background session (oak phase 2).
  startBackgroundSessions();
}

/** Optional extras of the register path: a nickname distinct from the login and the
 *  single-use secret parsed out of an invite link (undefined = the bare bootstrap
 *  registration of a fresh server's first member). */
export interface RegisterSessionOptions {
  nickname?: string;
  inviteSecret?: string;
}

export async function startSession(baseUrl: string, mode: "login" | "register", username: string, password: string, options?: RegisterSessionOptions): Promise<void> {
  const normalized = normalizeHostUrl(baseUrl);
  appStore.patch({ loginBusy: true, loginError: null });
  try {
    // Login through a THROWAWAY storage, then move the tokens into the record — the
    // session's own RestClient is built on the record afterwards.
    const bootstrapStorage = new MemoryTokenStorage();
    const loginClient = new RestClient({ baseUrl: normalized, tokenStorage: bootstrapStorage });
    if (mode === "login") {
      await loginClient.login(username, password);
    } else {
      await loginClient.register(username, password, options);
    }
    const tokens = bootstrapStorage.load();
    if (!tokens) {
      throw new Error("login returned no tokens");
    }
    const existing = connectionDirectory.getSnapshot().find(
      (record) => record.hostUrl === normalized && record.username === username,
    );
    let recordId: string;
    if (existing) {
      // Re-login of a saved server: rotate the record's token family in place.
      const previous = existing.refreshToken !== ""
        ? { token: existing.token, refreshToken: existing.refreshToken, expiresAt: existing.expiresAt }
        : null;
      if (previous !== null) {
        // M7: the replaced family's refresh dies server-side too — best-effort on
        // purpose, a dead/unreachable old token must not fail the fresh login (the
        // server's logout is idempotent, the token also dies at its own expiry).
        void loginClient.logout(previous.refreshToken).catch((error: unknown) => {
          log.warn("rest", `old-session logout after re-login failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await connectionDirectory.applyTokens(existing.id, tokens, previous);
      recordId = existing.id;
    } else {
      recordId = (await connectionDirectory.create({ hostUrl: normalized, username, tokens })).id;
    }
    await openSession(recordId);
  } catch (error) {
    appStore.patch({ loginError: errorMessage(error) });
  } finally {
    appStore.patch({ loginBusy: false });
  }
}

/**
 * Quick reachability probe used BEFORE a rail switch tears anything down: fetch
 * resolves on ANY HTTP answer (401/500 included — that still proves the server
 * is alive) and rejects only on a network failure. The timeout cap keeps a
 * black-hole host (Windows firewalls DROP instead of rejecting — live log
 * 2026-10-08: every fetch to a dead port hung the full window) from freezing
 * the switch; a plain refused port fails in milliseconds. No auth is sent.
 */
async function probeServerReachable(hostUrl: string, timeoutMillis: number = 4_000): Promise<void> {
  await fetch(`${hostUrl.replace(/\/+$/, "")}/api/server`, { signal: AbortSignal.timeout(timeoutMillis) });
}

/**
 * Rail click on another record: switch (resume) or re-login when the family is
 * dead. NEVER gated (user decision 2026-10-08): the rail is the primary
 * navigation and must stay clickable at all times — a dead target server means
 * openSession lands in the ACTIVE OFFLINE view (the user panel says Offline, a
 * quiet watcher reopens the session once the server answers), and the login
 * form appears solely when the server answered and rejected the tokens.
 */
export async function switchConnection(recordId: string): Promise<void> {
  const record = connectionDirectory.get(recordId);
  if (!record || activeSession?.recordId === recordId) {
    return;
  }
  // A Trust decision on the certificate this attempt tripped over re-runs it
  // (the offline landing probe dies on an untrusted https cert).
  appStore.patch({
    tlsRetry: () => {
      void switchConnection(recordId);
    },
  });
  try {
    await openSession(recordId);
  } catch (error) {
    // Only an ANSWERING server reaches this catch (network failures land in
    // the offline view inside openSession): its rejection of the credentials
    // genuinely needs a re-login.
    openLoginForm({
      loginError: errorMessage(error),
      loginPrefill: { url: record.hostUrl, username: record.username },
    });
  }
}

export async function removeConnection(recordId: string): Promise<void> {
  const wasActive = activeSession?.recordId === recordId;
  const record = connectionDirectory.get(recordId);
  if (wasActive) {
    await teardownSession();
  } else {
    disposeBackgroundSession(recordId);
  }
  socialDirectory.drop(recordId);
  if (record !== null && record.refreshToken !== "") {
    // M7: revoke the record's refresh server-side before forgetting it — best-effort
    // (an unreachable server must not block a local delete; the token dies at its
    // own expiry anyway). A throwaway client: the record's session is already torn
    // down and logout carries its credential in the body, not the header.
    const disposalClient = new RestClient({ baseUrl: record.hostUrl, tokenStorage: new MemoryTokenStorage() });
    void disposalClient.logout(record.refreshToken).catch((error: unknown) => {
      log.warn("rest", `logout on record delete failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await connectionDirectory.remove(recordId);
  if (wasActive) {
    // Removing the ACTIVE server must not strand the window on the "No server
    // connected" screen while other saved servers remain (user report): switch onto
    // the most recently used survivor. switchConnection promotes a live background
    // session instantly; a dead token family opens the re-login modal prefilled.
    const survivor = connectionDirectory.getSnapshot()[0];
    if (survivor !== undefined) {
      await switchConnection(survivor.id);
    }
    // No survivor left — the empty screen with the rail's "+" is the honest state.
  }
}

/** The ↻ in the user bar (oak's onRetryReconnect): attempt immediately. */
export function retryConnection(): void {
  activeSession?.stomp.reconnectNow();
}

/**
 * oak's reloginFor: re-enter the password for a SAVED server — a fresh login
 * rotates the record's token family in place and reopens the session. Used
 * when the refresh family died (ban+unban, long offline) and the click path
 * can no longer recover silently.
 */
export async function reloginConnection(recordId: string, password: string): Promise<void> {
  const record = connectionDirectory.get(recordId);
  if (!record || password.length === 0) {
    return;
  }
  const bootstrapStorage = new MemoryTokenStorage();
  const loginClient = new RestClient({ baseUrl: record.hostUrl, tokenStorage: bootstrapStorage });
  await loginClient.login(record.username, password);
  const tokens = bootstrapStorage.load();
  if (!tokens) {
    throw new Error("login returned no tokens");
  }
  const previous = record.refreshToken !== ""
    ? { token: record.token, refreshToken: record.refreshToken, expiresAt: record.expiresAt }
    : null;
  await connectionDirectory.applyTokens(recordId, tokens, previous);
  await openSession(recordId);
}

/** Bumped on EVERY opening of the login form: an openSession that started
 *  BEFORE the form was opened (the boot resume, the offline watcher) must not
 *  close it on completion — the user-opened Create dialog flashed and
 *  vanished exactly this way (live report 2026-10-12). */
let loginFormGeneration = 0;

function openLoginForm(fields: { loginError?: string | null; loginPrefill?: { url: string; username: string } | null }): void {
  loginFormGeneration += 1;
  appStore.patch({ loginFormOpen: true, loginError: null, loginPrefill: null, ...fields });
}

/** "+" on the rail: the login modal with an empty form (the live session stays alive). */
export function beginAddServer(): void {
  openLoginForm({});
}

/** The server dropdown's two triggers: the Sidebar's server-name header (anchored
 *  under it) and a right-click on a rail avatar (at the cursor, any record). */
export function openServerMenu(recordId: string, x: number, y: number): void {
  appStore.patch({ serverMenu: { recordId, x, y } });
}

export function closeServerMenu(): void {
  appStore.patch({ serverMenu: null });
}

/** The owner's "Transfer ownership" flow (Members section button → the modal). The
 *  preselect jumps the modal straight to the confirm step for that member. */
export function openOwnershipTransfer(preselectedUserId?: number): void {
  appStore.patch({ ownershipModalOpen: true, ownershipPreselect: preselectedUserId ?? null });
}

export function closeOwnershipTransfer(): void {
  appStore.patch({ ownershipModalOpen: false, ownershipPreselect: null });
}

/** ✕ / Esc on the login modal. */
export function closeLoginForm(): void {
  appStore.patch({ loginFormOpen: false, loginError: null });
}

async function openSession(recordId: string): Promise<void> {
  const record = connectionDirectory.get(recordId);
  if (!record) {
    return;
  }
  // The completion patches below close the login form — but ONLY when it was
  // not (re)opened while this openSession was flying: the boot resume and the
  // offline watcher may finish long after the user opened the Create dialog,
  // and must not slam it shut (loginFormGeneration, live report 2026-10-12).
  const formGenerationAtStart = loginFormGeneration;
  const formClosePatch = (): { loginFormOpen: false; loginError: null; loginPrefill: null } | Record<string, never> =>
    loginFormGeneration === formGenerationAtStart
      ? { loginFormOpen: false, loginError: null, loginPrefill: null }
      : {};
  // PROMOTE: a live background session for this record switches in place —
  // no teardown, no fresh handshake (oak's promoteActiveSession). The demoted
  // session stays alive in the map as a background listener.
  const existing = sessionMap.get(recordId) ?? null;
  if (existing !== null && !existing.isDisposed()) {
    await teardownVoice();
    teardownCall();
    roomAudio.stopLevelPolling();
    roomAudio.detachOwnMic();
    const demoted = activeSession;
    activeSession = existing;
    sessionMap.delete(recordId);
    // The promoted record must STOP feeding the aggregated directory: a live
    // binding (or its leftover entry) on the ACTIVE record merges its DMs with
    // its own live rows — duplicate row keys orphaned React nodes (live report:
    // stale dm-rows stacked above the channel list after home↔server toggles).
    unbindLiveBackgroundSession(recordId);
    socialDirectory.drop(recordId);
    if (demoted !== null && demoted !== existing && !demoted.isDisposed()) {
      sessionMap.set(demoted.recordId, demoted);
      if (!hasLiveSession(demoted.recordId)) {
        bindLiveBackgroundSession(demoted, connectionDirectory); // it feeds the directory now
      }
    }
    sessionBinding.set(existing);
    sessionsIndex.bump();
    // A promoted background session may sit deep in its reconnect backoff (its
    // server blinked while it was in the background) — the switch is the
    // user's explicit "connect me NOW", not "wait out the timer".
    if (!existing.stomp.isConnected()) {
      existing.stomp.reconnectNow();
    }
    appStore.patch({
      ...formClosePatch(),
      ownUsername: record.username,
      baseUrl: record.hostUrl,
      stompState: existing.stomp.isConnected() ? "connected" : "connecting",
      stompAttempt: 0,
      stompCountdown: null,
    });
    consumePendingOpen(existing);
    roomAudio.startLevelPolling();
    await roomAudio.resume();
    void startBackgroundSessions();
    return;
  }
  await teardownSession();
  const session = new ConnectionSession({ directory: connectionDirectory, recordId, hooks: makeSessionHooks(recordId) });
  activeSession = session;
  sessionBinding.set(session);
  sessionsIndex.bump();
  // Same invariant on the fresh-session path: a REST-fallback entry of this
  // record from its sessionless days must not survive its activation.
  socialDirectory.drop(recordId);
  // THE ACTIVE OFFLINE VIEW (user decision 2026-10-08): the rail switch must
  // ALWAYS go through. The quick probe after the teardown keeps a black-hole
  // host (a firewall DROP — the REST chain would hang for tens of seconds per
  // request) from freezing the switch; when the server does not answer, the
  // half-built session stays alive as the ACTIVE view with an "Offline" status
  // in the user panel and a quiet watcher that reopens everything once the
  // server is back.
  try {
    await probeServerReachable(record.hostUrl);
  } catch {
    enterActiveOfflineView(session, record, formClosePatch);
    return;
  }
  try {
    await session.start();
    session.attachmentCache.setDiskBudget(settingsStore.getSnapshot().imageCacheMegabytes * 1024 * 1024);
    await resolveSavedDevices(); // ids die across restarts — resolve by label first
    roomAudio.setOutputDevice(resolvedDevices.speaker); // the saved sink, before any chain attaches
    notifications.setOutputDevice(resolvedDevices.speaker); // UI sounds follow the same speaker (oak's playout line)
    appStore.patch({
      ...formClosePatch(),
      ownUsername: record.username,
      baseUrl: record.hostUrl,
    });
    // Remember the own avatar's key for the offline view (the roster is empty
    // there; this field is its only source — same trick as the server icon).
    const ownSummary = session.rosterStore.getSnapshot().users.find((user) => user.username === record.username) ?? null;
    void connectionDirectory.update(recordId, { cachedOwnAvatarKey: ownSummary?.avatarKey ?? null });
    // A DM/channel clicked on a NON-active instance: open it instead of the
    // restored last channel (oak's pendingOpenDm).
    consumePendingOpen(session);
    roomAudio.startLevelPolling();
    await roomAudio.resume();
    // Bring every other record up as a LIVE background session; the REST
    // snapshot loader only covers records that cannot hold a session.
    void startBackgroundSessions();
  } catch (error) {
    if (error instanceof ApiError) {
      await teardownSession();
      throw error;
    }
    // The probe passed but the bootstrap still died on the network (a flaky
    // window): the same offline view, not a dead screen.
    enterActiveOfflineView(session, record, formClosePatch);
  }
}

/** Paint the half-built session as the ACTIVE OFFLINE view: the familiar
 *  server screen with empty stores and an "Offline" status in the user panel.
 *  The session's STOMP was never started, so nothing will overwrite the status.
 *  `formClosePatch` comes from the owning openSession (the login-form guard). */
function enterActiveOfflineView(
  session: ConnectionSession,
  record: ConnectionRecord,
  // Default: never touch the form (the offline watcher's fallback call has no
  // owning openSession to inherit the guard from).
  formClosePatch: () => { loginFormOpen: false; loginError: null; loginPrefill: null } | Record<string, never> = () => ({}),
): void {
  if (activeSession !== session) {
    return; // the user switched away while the probe was flying
  }
  appStore.patch({
    ...formClosePatch(),
    ownUsername: record.username,
    baseUrl: record.hostUrl,
    stompState: "off", // the user panel renders this as "Offline"
    stompAttempt: 0,
    stompCountdown: null,
  });
  log.warn("app", `${record.hostUrl} unreachable — active offline view, watching for the server`);
  armOfflineWatch(session.recordId);
}

let offlineWatchRecordId: string | null = null;
let offlineWatchTimer: number | null = null;

/** Re-probe the ACTIVE offline view's server every 10 s; the moment it answers,
 *  reopen the session for real. Re-arming for another record retargets the
 *  watch; any switch to a live session disarms it. */
function armOfflineWatch(recordId: string): void {
  offlineWatchRecordId = recordId;
  if (offlineWatchTimer !== null) {
    return; // the shared timer serves whatever record is watched now
  }
  offlineWatchTimer = window.setTimeout(function offlineWatchTick(): void {
    offlineWatchTimer = null;
    const watched = offlineWatchRecordId;
    const record = watched !== null ? connectionDirectory.get(watched) : null;
    if (watched === null || record === null || activeSession === null
      || activeSession.recordId !== watched || activeSession.stomp.isConnected()) {
      offlineWatchRecordId = null; // switched away / connected / record gone
      return;
    }
    void probeServerReachable(record.hostUrl).then(() => {
      if (offlineWatchRecordId !== watched || activeSession?.recordId !== watched) {
        return;
      }
      offlineWatchRecordId = null;
      log.info("app", `${record.hostUrl} is back — reopening the session`);
      void openSession(watched).catch(() => enterActiveOfflineView(activeSession!, record));
    }).catch(() => {
      if (offlineWatchRecordId !== watched) {
        return;
      }
      offlineWatchTimer = window.setTimeout(offlineWatchTick, 10_000);
    });
  }, 10_000);
}

/** A quiet revival pass for background records whose start() failed — the
 *  server may simply have been down (at startup or later); without this the
 *  record stayed on REST snapshots forever. Mirrors onStompExhausted's 30 s
 *  background restart cadence. */
let backgroundRevivalTimer: number | null = null;

function scheduleBackgroundRevival(): void {
  if (backgroundRevivalTimer !== null) {
    return; // one pass, one timer — failures restack it
  }
  backgroundRevivalTimer = window.setTimeout(() => {
    backgroundRevivalTimer = null;
    startBackgroundSessions();
  }, 30_000);
}

/** Start (once) a background session for every saved record that has none.
 *  Each start is GATED by the reachability probe: against a black-hole host
 *  (connection accepted, then silence — a firewall DROP) the old path fired
 *  the whole REST bootstrap chain, and those 20-s-timeout fetches saturated
 *  the browser's per-host connection pool, freezing every other request to
 *  that host INCLUDING interactive switch probes (live report 2026-10-08).
 *  A probe failure skips the session entirely — the revival pass retries. */
function startBackgroundSessions(): void {
  for (const record of connectionDirectory.getSnapshot()) {
    // bootResumeRecordId: the boot ladder owns that record — a background start
    // racing the ladder could be PROMOTED half-started by openSession.
    if (record.token === EXPIRED_MARKER || record.refreshToken === ""
      || record.id === activeSession?.recordId || record.id === bootResumeRecordId) {
      continue;
    }
    if (sessionMap.has(record.id)) {
      continue;
    }
    void probeServerReachable(record.hostUrl, 2_500).then(() => {
      if (sessionMap.has(record.id) || connectionDirectory.get(record.id) === null) {
        return; // someone started it first / the record is gone
      }
      const session = new ConnectionSession({ directory: connectionDirectory, recordId: record.id, hooks: makeSessionHooks(record.id) });
      sessionMap.set(record.id, session);
      sessionsIndex.bump();
      bindLiveBackgroundSession(session, connectionDirectory);
      return session.start().catch((error: unknown) => {
        log.warn("app", `background session for ${record.username} @ ${record.hostUrl} failed (${errorMessage(error)}) — REST snapshots, will retry`);
        disposeBackgroundSession(record.id);
        scheduleBackgroundRevival();
      });
    }).catch(() => {
      // Quiet by design: dead servers are the NORM for saved-but-inactive
      // records; a warn per revival pass is noise (the ladder owns retries).
      scheduleBackgroundRevival();
    });
  }
}

/** Dispose ONE background session (expired/kicked/failed start); the active
 *  one goes through teardownSession. */
function disposeBackgroundSession(recordId: string): void {
  const session = sessionMap.get(recordId);
  if (session === undefined || session === activeSession) {
    return;
  }
  sessionMap.delete(recordId);
  sessionsIndex.bump();
  session.dispose();
  unbindLiveBackgroundSession(recordId);
  // A live background-call card dies with its session (nothing to accept on).
  if (backgroundRing !== null && backgroundRing.recordId === recordId) {
    clearBackgroundRing();
  }
  // The record's live voice-invite cards die with it too (Join would lead nowhere).
  for (const [cardId, entry] of voiceInvites) {
    if (entry.recordId === recordId) {
      voiceInvites.delete(cardId);
      notifications.dismissVoiceInviteCard(cardId);
    }
  }
  if (pendingVoiceJoin !== null && pendingVoiceJoin.recordId === recordId) {
    pendingVoiceJoin = null;
  }
  void loadBackgroundSocial(connectionDirectory, activeSession?.recordId ?? "");
}

export async function teardownSession(): Promise<void> {
  teardownCall();
  await teardownVoice();
  roomAudio.stopLevelPolling();
  roomAudio.detachOwnMic();
  const dying = activeSession;
  activeSession = null;
  sessionBinding.set(null);
  sessionsIndex.bump();
  if (dying !== null) {
    sessionMap.delete(dying.recordId);
    dying.dispose();
  }
  appStore.patch({
    stompState: "off",
    stompAttempt: 0,
    stompCountdown: null,
    connectionQuality: initialConnectionQuality(),
    ownUsername: null,
    activeChannelId: null,
    dmMode: false,
    activeDmId: null,
    friendsTab: "ALL",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    voiceRttMillis: null,
    participants: [],
    sharing: false,
    cameraOn: false,
    popoutActive: false,
    viewingFeedId: null,
    serverSettingsOpen: false,
    searchOpen: false,
    activeAround: null,
    activeDiscussion: null,
    sidebarDiscussions: false,
    serverMenu: null,
    ownershipModalOpen: false,
    ownershipPreselect: null,
    // pendingOpenDm/pendingOpenChannel/pendingOpenDiscussion deliberately survive too — a
    // switch that lands on the login modal should still open the clicked chat once the
    // user re-logs in.
    // userSettingsOpen is deliberately NOT reset here: the username rename
    // restarts the session WITH the settings window open (oak keeps it). Every
    // path that truly kills the session closes it explicitly (expired, kicked).
  });
}

// ---------------------------------------------------------------------------
// Active text channel (lastChannel persistence)
// ---------------------------------------------------------------------------

export function setActiveChannel(channelId: number, aroundMessageId?: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  ackActiveChannel(); // oak acks the channel being LEFT before the switch lands
  if (aroundMessageId !== undefined) {
    // The search-result jump: open the channel ON the message (the around window).
    // ONE patch — activeAround rides along so ChatPane's open effect skips loadHistory
    // and MessageList's first layout centers on the target instead of the bottom.
    // An around open NEVER acks: the window's last id is mid-history, and acking it
    // would zero the channel's real unread.
    appStore.patch({
      activeChannelId: channelId,
      dmMode: false,
      activeDmId: null,
      roomViewOpen: false,
      activeDiscussion: null,
      activeAround: { channelId, messageId: aroundMessageId },
    });
    void session.loadAround(channelId, aroundMessageId)
      .catch((error: unknown) => {
        // 404 = the message was deleted since the search snapshot — fall back to the tail.
        log.warn("chat", `around open failed, falling back to the tail: ${errorMessage(error)}`);
        appStore.patch({ activeAround: null });
        if (error instanceof ApiError && error.status === 404) {
          notifications.showToast({ title: "space", channelName: "", body: "Message not found — showing the latest messages" });
        }
        return session.loadHistory(channelId);
      })
      .catch((error: unknown) => {
        log.warn("chat", `history load failed: ${errorMessage(error)}`);
      });
    void connectionDirectory.update(session.recordId, { lastChannelId: channelId });
    return;
  }
  appStore.patch({ activeChannelId: channelId, dmMode: false, activeDmId: null, roomViewOpen: false, activeAround: null, activeDiscussion: null });
  // A channel left in the AROUND state must not stay stuck on its window: loadHistory is
  // a no-op once isLoaded, so refetch the tail explicitly (applySnapshot clears the flag).
  if (session.messageStore.isAroundWithoutTail(channelId)) {
    void session.reloadTail(channelId)
      .then(() => ackActiveChannel())
      .catch((error: unknown) => {
        log.warn("chat", `tail reload failed: ${errorMessage(error)}`);
      });
  } else {
    void session.loadHistory(channelId)
      .then(() => ackActiveChannel())
      .catch((error: unknown) => {
        log.warn("chat", `history load failed: ${errorMessage(error)}`);
      });
  }
  void connectionDirectory.update(session.recordId, { lastChannelId: channelId });
}

// ---------------------------------------------------------------------------
// Message search (#481)
// ---------------------------------------------------------------------------

/** Ctrl+F / the header loupe: show or hide the search panel (the right column). */
export function toggleSearch(): void {
  appStore.patch({ searchOpen: !appStore.getSnapshot().searchOpen });
}

export function setSearchScope(scope: "channel" | "server"): void {
  appStore.patch({ searchScope: scope });
}

/** A search-result click: open the target channel ON the message. Works while the
 *  channel is already open (just re-arms activeAround — MessageList reacts mounted)
 *  and for DMs (openDm + the around patch on top). */
export function openChannelAtMessage(channelId: number, messageId: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  if (session.channelStore.get(channelId) !== null) {
    const state = appStore.getSnapshot();
    if (!state.dmMode && state.activeChannelId === channelId) {
      // Already looking at it — re-arm the window (an around jump within the channel).
      appStore.patch({ activeAround: { channelId, messageId } });
      void session.loadAround(channelId, messageId).catch((error: unknown) => {
        log.warn("chat", `around open failed: ${errorMessage(error)}`);
        appStore.patch({ activeAround: null });
      });
      return;
    }
    setActiveChannel(channelId, messageId);
    return;
  }
  // Not a server channel → a DM of this session: open it, then arm the window on top.
  openDm(channelId);
  appStore.patch({ activeAround: { channelId, messageId } });
  void session.loadAround(channelId, messageId).catch((error: unknown) => {
    log.warn("chat", `around open failed: ${errorMessage(error)}`);
    appStore.patch({ activeAround: null });
  });
}

// ---------------------------------------------------------------------------
// Discussions (threads)
// ---------------------------------------------------------------------------

/** The sidebar's channels↔discussions switch (the section-title dropdown and the channel
 *  badges both land here). Entering the discussions side fetches the mine list. */
export function setSidebarDiscussions(shown: boolean): void {
  if (appStore.getSnapshot().sidebarDiscussions === shown) {
    return;
  }
  appStore.patch({ sidebarDiscussions: shown });
  if (shown && activeSession !== null) {
    void activeSession.fetchMyDiscussions().catch((error: unknown) => {
      log.warn("chat", `discussions list failed: ${errorMessage(error)}`);
    });
  }
}

/** Open a discussion view: the parent channel becomes the active channel (sidebar
 *  highlight stays), the chat area swaps to the thread. The parent's own chat state
 *  (around window etc.) is reset by the setActiveChannel pass-through. */
export function openDiscussion(discussion: { id: number; parentChannelId: number; originMessageId: number }): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  const state = appStore.getSnapshot();
  if (state.dmMode || state.activeChannelId !== discussion.parentChannelId) {
    // setActiveChannel also clears activeDiscussion — patched again right after.
    setActiveChannel(discussion.parentChannelId);
  } else {
    ackActiveChannel();
  }
  appStore.patch({
    activeDiscussion: { channelId: discussion.parentChannelId, discussionId: discussion.id, originMessageId: discussion.originMessageId },
    activeAround: null,
    roomViewOpen: false,
  });
  void session.openDiscussion(discussion.id).catch((error: unknown) => {
    log.warn("chat", `discussion open failed: ${errorMessage(error)}`);
    closeDiscussionView();
  });
}

/** The LAZY-CREATE draft (user rule): "Start discussion" opens the thread view WITHOUT a
 *  server object — the discussion materialises with the first reply (ChatPane sends it
 *  through session.startDiscussionWithMessage). The origin message renders from the
 *  parent channel's own loaded list; no follow/close controls exist yet. */
export function openDraftDiscussion(origin: { channelId: number; messageId: number }): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  const state = appStore.getSnapshot();
  if (state.dmMode || state.activeChannelId !== origin.channelId) {
    setActiveChannel(origin.channelId);
  } else {
    ackActiveChannel();
  }
  appStore.patch({
    activeDiscussion: { channelId: origin.channelId, discussionId: null, originMessageId: origin.messageId },
    activeAround: null,
    roomViewOpen: false,
  });
}

/** A thread of a NON-active instance (a background mention toast click): switch there
 *  and open it once the session is up — same contract as openChannelOnInstance. */
export function openDiscussionOnInstance(recordId: string, discussionId: number): void {
  appStore.patch({ pendingOpenDiscussion: { recordId, discussionId } });
  void switchConnection(recordId);
}

/** Leave the thread view — back to the parent channel's own chat (its message list is
 *  still loaded; a discussion view never disturbs it). */
export function closeDiscussionView(): void {
  if (appStore.getSnapshot().activeDiscussion !== null) {
    appStore.patch({ activeDiscussion: null });
  }
}

/** The origin panel's Close button (MANAGE_MESSAGES): close for everyone, then leave
 *  the view. The REMOVED push is idempotent on top of the local purge. */
export function closeDiscussionForEveryone(discussionId: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  void session.closeDiscussion(discussionId)
    .then(() => {
      closeDiscussionView();
      notifications.showToast({ title: "space", channelName: "", body: "Discussion closed" });
    })
    .catch((error: unknown) => {
      notifications.showToast({ title: "space", channelName: "", body: errorMessage(error) });
    });
}



// ---------------------------------------------------------------------------
// Home mode (friends + DMs)
// ---------------------------------------------------------------------------

/** The Home button: toggle between the server view and the DM/friends view. */
export function toggleHomeMode(): void {
  const state = appStore.getSnapshot();
  const next = !state.dmMode;
  appStore.patch({ dmMode: next, activeDmId: next ? state.activeDmId : null, activeDiscussion: null });
  if (next && activeSession !== null) {
    // Entering the aggregated view refreshes every other instance's snapshot.
    void loadBackgroundSocial(connectionDirectory, activeSession.recordId);
  }
}

/** A DM row of a NON-active instance: switch there and open it once up (oak). */
export function openDmOnInstance(recordId: string, dmId: number): void {
  appStore.patch({ pendingOpenDm: { recordId, dmId } });
  void switchConnection(recordId);
}

/** A server channel of a NON-active instance (a background toast click): switch
 *  there and open the channel once the session is up — same contract as the DM. */
export function openChannelOnInstance(recordId: string, channelId: number): void {
  appStore.patch({ pendingOpenChannel: { recordId, channelId } });
  void switchConnection(recordId);
}

/** Consumes a pending open for the just-activated session: the clicked target
 *  (a DM, then a server channel) replaces the restored last channel; a channel
 *  deleted while away falls through to the ordinary restore. */
function consumePendingOpen(session: ConnectionSession): void {
  // A background call the user ACCEPTED: the now-promoted session takes the
  // ring (ringing-in + the normal accept path) — before any channel restore.
  if (pendingBackgroundAccept !== null && pendingBackgroundAccept.recordId === session.recordId) {
    const pending = pendingBackgroundAccept;
    pendingBackgroundAccept = null;
    if (appStore.getSnapshot().callState === "idle") {
      appStore.patch({ callState: "ringing-in", callPeer: pending.peer, callHealthy: true, callSeconds: 0 });
      void acceptCallNow();
      return;
    }
  }
  const state = appStore.getSnapshot();
  const pendingDm = state.pendingOpenDm;
  if (pendingDm !== null && pendingDm.recordId === session.recordId) {
    appStore.patch({ pendingOpenDm: null });
    openDm(pendingDm.dmId);
    return;
  }
  const pendingChannel = state.pendingOpenChannel;
  if (pendingChannel !== null && pendingChannel.recordId === session.recordId) {
    appStore.patch({ pendingOpenChannel: null });
    if (session.channelStore.get(pendingChannel.channelId)?.locked !== true) {
      setActiveChannel(pendingChannel.channelId);
      return;
    }
  }
  const pendingDiscussion = state.pendingOpenDiscussion;
  if (pendingDiscussion !== null && pendingDiscussion.recordId === session.recordId) {
    appStore.patch({ pendingOpenDiscussion: null });
    const row = session.discussionsStore.byId(pendingDiscussion.discussionId);
    if (row !== undefined) {
      openDiscussion(row);
      return;
    }
  }
  // A background voice invite the user JOINED: the promoted instance joins the
  // room. A failed gate (the room vanished/locked for this viewer) falls through
  // to the ordinary restore — the card is already gone either way.
  if (pendingVoiceJoin !== null && pendingVoiceJoin.recordId === session.recordId) {
    const pending = pendingVoiceJoin;
    pendingVoiceJoin = null;
    if (joinInviteChannel(session, pending.channelId)) {
      return;
    }
  }
  restoreLastChannel(session);
}

/** Clicking the ACTIVE server icon while in Home = go back to the server view. */
export function exitHomeMode(): void {
  if (appStore.getSnapshot().dmMode) {
    appStore.patch({ dmMode: false, activeDmId: null });
  }
}

// ---------------------------------------------------------------------------
// Settings surfaces (M7): the server settings screen + the user settings modal
// ---------------------------------------------------------------------------

/** oak's canManageAnySettings — gates the Server Settings entry point. MANAGE_SERVER
 *  belongs here too: it feeds the Overview section (rename/icon/connection), so a
 *  holder of only that bit can reach the one screen it powers. */
export function canManageServerSettings(session: ConnectionSession | null): boolean {
  if (session === null) {
    return false;
  }
  const permissions = session.permissionStore.getSnapshot().my?.permissions ?? [];
  return permissions.some((name) =>
    name === "MANAGE_SERVER" || name === "MANAGE_ROLES" || name === "MANAGE_MEMBERS" || name === "KICK_MEMBERS"
    || name === "BAN_MEMBERS" || name === "MANAGE_CHANNELS" || name === "MANAGE_EMOJIS" || name === "MANAGE_STORAGE");
}

export function openServerSettings(): void {
  const session = activeSession;
  if (!canManageServerSettings(session)) {
    return;
  }
  appStore.patch({ serverSettingsOpen: true, roomViewOpen: false });
}

export function setServerSettingsSection(section: AppState["serverSettingsSection"]): void {
  appStore.patch({ serverSettingsSection: section });
}

export function closeServerSettings(): void {
  appStore.patch({ serverSettingsOpen: false });
}

export function toggleUserSettings(): void {
  appStore.patch({ userSettingsOpen: !appStore.getSnapshot().userSettingsOpen, userSettingsScope: "client" });
}

/** The server dropdown's "Account settings" entry — the settings modal scoped
 *  to General + Account (the server-scoped identity sections). */
export function openAccountSettings(): void {
  appStore.patch({ userSettingsOpen: true, userSettingsScope: "account" });
}

/** The Server Settings gate for ANY record: the active session's own mask, or the
 *  record's live BACKGROUND session's (the rail right-click on a non-active server
 *  — every healthy record holds a background session, so the gate is real; with no
 *  live session the entry hides, and switching would land on the login modal anyway). */
export function canManageServerSettingsOfRecord(recordId: string): boolean {
  if (activeSession?.recordId === recordId) {
    return canManageServerSettings(activeSession);
  }
  const background = sessionMap.get(recordId);
  return background !== undefined && !background.isDisposed() && canManageServerSettings(background);
}

/** The settings entries of a NON-active record (user request 2026-09-24): switch
 *  to that server first, then open the surface. switchConnection swallows its own
 *  failures (the login modal is already up) — the settings open only when the
 *  switch actually LANDED, so a failed switch never opens the previous server's
 *  settings against a dead binding. */
export async function switchAndOpenServerSettings(recordId: string): Promise<void> {
  await switchConnection(recordId);
  if (activeSession?.recordId === recordId) {
    openServerSettings(); // re-checks the gate against the now-active session
  }
}

export async function switchAndOpenAccountSettings(recordId: string): Promise<void> {
  await switchConnection(recordId);
  if (activeSession?.recordId === recordId) {
    openAccountSettings();
  }
}

function notificationPrefsFor(recordId: string): NotificationPrefs {
  return connectionDirectory.get(recordId)?.notifPrefs ?? DEFAULT_NOTIFICATION_PREFS;
}

/** The signed-in user's id + held role ids on THIS instance — the mention match
 *  key for @user/@role. Resolved from the member roster (oak extracts self the
 *  same way); before the roster lands nothing matches, oak's "safe before the
 *  roster" rule. Works for background sessions too — each keeps its own stores. */
function selfIdentityFor(session: ConnectionSession): MentionIdentity {
  const username = session.username();
  const member = session.memberStore.getSnapshot().members
    .find((entry) => entry.username === username);
  return { userId: member?.userId ?? null, roleIds: member?.roleIds ?? [] };
}

/** The instance's display name for toast headers (cached server name, host URL
 *  as the offline fallback — same source the rail and Connections show). */
function serverDisplayName(recordId: string): string {
  const record = connectionDirectory.get(recordId);
  return record?.cachedServerName ?? record?.hostUrl ?? "";
}

export async function updateNotificationPrefs(recordId: string, patch: Partial<NotificationPrefs>): Promise<void> {
  const record = connectionDirectory.get(recordId);
  if (!record) {
    return;
  }
  await connectionDirectory.update(recordId, {
    notifPrefs: { ...record.notifPrefs, ...patch },
  });
}

/**
 * Password change: the response carries a FRESH pair (the old family is revoked)
 * which rest.changePassword saves into the record — the STOMP session survives
 * (the server only checks the JWT on CONNECT).
 */
export async function changeAccountPassword(oldPassword: string, newPassword: string): Promise<void> {
  const session = activeSession;
  if (!session) {
    throw new Error("not connected");
  }
  await session.rest.changePassword(oldPassword, newPassword);
}

/**
 * Username change: the JWT subject IS the username, so the server revokes every
 * refresh family and the old access token dies with it. Record update + token
 * rotation happen first, then the WHOLE session restarts (the old STOMP
 * principal would break every @MessageMapping). Must not run while in voice/call.
 */
export async function changeAccountUsername(newUsername: string): Promise<void> {
  const session = activeSession;
  if (!session) {
    throw new Error("not connected");
  }
  if (inVoiceOrCall()) {
    throw new Error("Leave voice and calls before changing your username.");
  }
  const record = connectionDirectory.get(session.recordId);
  if (!record) {
    throw new Error("no connection record");
  }
  const result = await session.rest.changeUsername(newUsername);
  const previous = { token: record.token, refreshToken: record.refreshToken, expiresAt: record.expiresAt };
  await connectionDirectory.update(record.id, { username: result.user.username });
  await connectionDirectory.applyTokens(record.id, {
    token: result.auth.token,
    refreshToken: result.auth.refreshToken,
    expiresAt: Date.now() + result.auth.expiresIn * 1000,
  }, previous);
  // oak keeps the Settings window OPEN across a rename (the field's baseline
  // moves to the new name): teardownSession deliberately does NOT reset
  // userSettingsOpen, and App renders the overlay against the previous session
  // object while the binding blinks through the restart.
  await openSession(session.recordId); // quiet restart: same record, new principal
}

export function inVoiceOrCall(): boolean {
  const state = appStore.getSnapshot();
  return state.activeVoiceChannelId !== null || state.callState !== "idle";
}

/** The single source for Enter semantics (composer AND inline editor): default = Enter sends. */
export function enterInsertsNewline(): boolean {
  return settingsStore.getSnapshot().ctrlEnterSends;
}

export function setFriendsTab(tab: FriendsTab): void {
  appStore.patch({ dmMode: true, activeDmId: null, friendsTab: tab });
}

/** oak's room-view toggle: clicking the voice bar swaps the chat area to the
 *  participant tiles and back — voice itself NEVER leaves the left card. */
export function toggleRoomView(): void {
  appStore.patch({ roomViewOpen: !appStore.getSnapshot().roomViewOpen });
}

/** Open one DM chat (the row click / the toast click / the friends "Message" button). */
export function openDm(channelId: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  if (appStore.getSnapshot().activeDmId !== channelId) {
    ackActiveChannel(); // oak acks the chat being LEFT before the switch lands
  }
  appStore.patch({ dmMode: true, activeDmId: channelId, roomViewOpen: false, activeDiscussion: null });
  void session.loadHistory(channelId)
    .then(() => ackActiveChannel())
    .catch((error: unknown) => {
      log.warn("chat", `history load failed: ${errorMessage(error)}`);
    });
}

/** Friends "Message": get-or-create the 1:1 DM, then open it. */
export async function openDmWithUser(userId: number): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  const dm = await session.openDmWith(userId);
  openDm(dm.id);
}

/** Perf-gate helper: fill the ACTIVE channel's list locally with synthetic messages. */
export function seedSyntheticMessages(count: number): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeChannelId;
  if (!session || channelId === null) {
    log.warn("perf", "seed needs an active text channel");
    return;
  }
  const baseTime = Date.now() - count * 60_000;
  const authors = ["alice", "bob", "carol", "dave"];
  const synthetic: Message[] = Array.from({ length: count }, (_unused, index) => {
    const id = index + 1;
    const authorUsername = authors[index % authors.length]!;
    const lineCount = 1 + (index % 3);
    return {
      id,
      channelId,
      authorId: index % authors.length,
      authorUsername,
      content: `synthetic message ${id} — ${"lorem ipsum dolor sit amet ".repeat(lineCount).trim()}`,
      createdAt: new Date(baseTime + id * 60_000).toISOString(),
      attachments: [],
      mentions: [],
      editedAt: index % 17 === 0 ? new Date(baseTime + id * 60_000 + 5000).toISOString() : null,
      reactions: index % 23 === 0 ? [{ reaction: "thumbsup", count: 2, userIds: [1, 2], usernames: ["alice", "bob"] }] : [],
      reply: index % 31 === 0 ? { messageId: Math.max(1, id - 1), authorId: 0, authorUsername: authors[(index + 3) % authors.length]!, preview: `synthetic message ${id - 1}`, createdAt: new Date(baseTime + (id - 1) * 60_000).toISOString(), deleted: false, forward: null, reply: null } : null,
      forward: null,
      pinned: false,
      pinnedBy: null,
      pinnedAt: null,
      sticker: null,
    };
  });
  session.messageStore.applySnapshot(channelId, synthetic);
  log.info("perf", `seeded ${count} synthetic messages into channel #${channelId} — scroll it`);
}

/** Ack the open chat (server channel OR DM) up to its newest loaded message. */
export function ackActiveChannel(): void {
  const session = activeSession;
  const appState = appStore.getSnapshot();
  const channelId = appState.dmMode ? appState.activeDmId : appState.activeChannelId;
  if (!session || channelId === null) {
    return;
  }
  // An around window ends mid-history: its last loaded id is NOT the channel's newest,
  // and acking it would zero the real unread (the local store's ack is not monotonic).
  // The window acks once its gap is paginated through (or "Jump to present" runs).
  if (session.messageStore.isAroundWithoutTail(channelId)) {
    return;
  }
  const messages = session.messageStore.listFor(channelId);
  const lastId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const readState = session.readStateStore.get(channelId);
  if (lastId === null && readState.unreadCount === 0) {
    return;
  }
  if (lastId !== null && readState.lastReadMessageId === lastId && readState.unreadCount === 0) {
    return;
  }
  session.ackChannelRead(channelId, lastId);
}

/** Cross-instance forward: a THROWAWAY client for the target record (v1: one active session). */
export async function forwardCrossInstance(targetRecordId: string, targetChannelId: number, snapshot: {
  content: string | null;
  attachments?: { key: string; fileName: string; width: number | null; height: number | null }[] | null;
  originServer: string;
  originChannel: string;
  originAuthorId: number;
  originAuthorName: string;
  originCreatedAt: string;
  originReply: Message["reply"];
}): Promise<void> {
  const record = connectionDirectory.get(targetRecordId);
  if (!record) {
    throw new Error("target server record not found");
  }
  const client = new RestClient({
    baseUrl: record.hostUrl,
    tokenStorage: new RecordTokenStorage(connectionDirectory, targetRecordId),
  });
  await client.forwardMessage(targetChannelId, {
    sourceMessageId: null,
    content: snapshot.content,
    attachments: snapshot.attachments ?? null,
    originServer: snapshot.originServer,
    originChannel: snapshot.originChannel,
    originAuthorId: snapshot.originAuthorId,
    originAuthorName: snapshot.originAuthorName,
    originCreatedAt: snapshot.originCreatedAt,
    originReply: snapshot.originReply,
  });
}

/** Target-instance upload slot + byte PUT for cross-instance attachment re-upload. */
function targetRecordClient(targetRecordId: string): RestClient {
  const record = connectionDirectory.get(targetRecordId);
  if (!record) {
    throw new Error("target server record not found");
  }
  return new RestClient({
    baseUrl: record.hostUrl,
    tokenStorage: new RecordTokenStorage(connectionDirectory, targetRecordId),
  });
}

export async function forwardRequestUpload(targetRecordId: string, fileName: string): Promise<{ key: string; uploadUrl: string }> {
  return await targetRecordClient(targetRecordId).requestAttachmentUpload(fileName);
}

export async function forwardUploadBytes(targetRecordId: string, uploadUrl: string, bytes: Uint8Array): Promise<void> {
  await targetRecordClient(targetRecordId).uploadBytes(uploadUrl, bytes.buffer as ArrayBuffer, "application/octet-stream");
}

function restoreLastChannel(session: ConnectionSession): void {
  const record = connectionDirectory.get(session.recordId);
  const textChannels = session.channelStore.getSnapshot().filter((channel) => channel.type === "TEXT");
  // The saved channel only qualifies while it is still VISIBLE AND UNLOCKED —
  // a revoked READ keeps the channel in the viewer's list but locked, and
  // restoring into it lands on a READ_MESSAGE_HISTORY 403 (live report).
  const preferred = record?.lastChannelId != null
    ? textChannels.find((channel) => channel.id === record.lastChannelId && !channel.locked)
    : undefined;
  const chosen = preferred ?? textChannels.find((channel) => !channel.locked) ?? null;
  if (chosen) {
    setActiveChannel(chosen.id);
  } else {
    appStore.patch({ activeChannelId: null });
  }
}

function ensureActiveChannelExists(): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  const current = appStore.getSnapshot().activeChannelId;
  // A channel that turned LOCKED under the sitting user (a role edit pulled
  // READ) is as dead as a deleted one — re-home to an accessible channel.
  const stillUsable = current !== null
    && session.channelStore.get(current)?.locked !== true;
  if (!stillUsable) {
    pickFallbackTextChannel();
  }
}

function pickFallbackTextChannel(): void {
  const session = activeSession;
  if (!session) {
    appStore.patch({ activeChannelId: null });
    return;
  }
  const fallback = session.channelStore.getSnapshot().find((channel) => channel.type === "TEXT" && !channel.locked) ?? null;
  if (fallback) {
    setActiveChannel(fallback.id);
  } else {
    appStore.patch({ activeChannelId: null });
    void connectionDirectory.update(session.recordId, { lastChannelId: null });
  }
}

// ---------------------------------------------------------------------------
// Voice session (room → Janus → SFU)
// ---------------------------------------------------------------------------

/** Rejoin ladder state (oak parity: 5 attempts, delays 1/2/4/8/8 s). */
let voiceRejoin: { channelId: number; attempt: number; timer: number } | null = null;

function cancelVoiceRejoin(): void {
  if (voiceRejoin !== null) {
    window.clearTimeout(voiceRejoin.timer);
    voiceRejoin = null;
  }
}

/** The AFK heartbeat interval: while the ACTIVE session is in a voice room, report
 *  activity every 30 s (speaking, or system-wide input idle under the grace). */
let afkReportTimer: number | null = null;

function startAfkReporting(): void {
  if (afkReportTimer !== null) {
    return; // already running (a rejoin into another room keeps the one timer)
  }
  afkReportTimer = window.setInterval(() => {
    void reportAfkActivity();
  }, 30_000);
}

function stopAfkReporting(): void {
  if (afkReportTimer !== null) {
    window.clearInterval(afkReportTimer);
    afkReportTimer = null;
  }
}

async function reportAfkActivity(): Promise<void> {
  const session = activeSession;
  if (session === null || appStore.getSnapshot().activeVoiceChannelId === null) {
    return;
  }
  // A missing bridge (old preload) degrades to speaking-only — never a false "active".
  const idleSeconds = window.spaceIdle ? await window.spaceIdle.getSystemIdleTime() : Number.POSITIVE_INFINITY;
  const speaking = roomAudio.speakingSnapshot().has(appStore.getSnapshot().ownUsername ?? "");
  if (isAfkActive(idleSeconds, speaking)) {
    session.stomp.send("/app/voice.activity", {});
  }
}

export async function joinVoice(channel: Channel): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  cancelVoiceRejoin();
  await teardownVoice();
  // Entering a room resets MY OWN marks only (the server drops self-marks on
  // leave and re-publishes a surviving moderator mark on our enter). Other
  // members' marks stay — they are still true server-side; wiping them made a
  // muted member's badge VANISH for the joining viewer (live report
  // 2026-09-17). The server additionally re-seeds the whole channel's state
  // on every join, so even a fresh client learns everyone's current marks.
  // EXCEPTION — the AFK room: the sweep's mod-mute state push races this reset
  // (it arrives right around the MOVED-driven re-join), so entering the AFK
  // channel must NOT drop the incoming moderator mute.
  const enteringAfkRoom = channel.afk === true;
  if (!enteringAfkRoom) {
    session.voiceControlStore.clearUser(session.username());
    voiceCompliance.micMuted = false;
    voiceCompliance.shareAudioMuted = false;
    voiceCompliance.deafened = false;
  }
  roomAudio.setDeafened(false);
  appStore.patch({ activeVoiceChannelId: channel.id, voiceState: "connecting", stateDetail: null, voiceRttMillis: null, participants: [], viewingFeedId: null });
  // The share/camera gate reads the per-channel STREAM bit — a voice channel is
  // often never OPENED as a chat tab, so its bits would never be cached otherwise.
  void session.ensureChannelPermissions(channel.id);
  session.stomp.send("/app/voice.join", { channelId: channel.id });
  startAfkReporting();

  try {
    await connectVoiceRoom(channel);
    if (settingsStore.getSnapshot().soundEnabled) { // the app sound switch (ding + knocks)
      notifications.playKnock("join");
    }
  } catch (error) {
    // The bar's detail gets overwritten by the leaving-state — the cause lives here.
    log.error("voice", `room join failed: ${errorMessage(error)}`);
    appStore.patch({ voiceState: "failed", stateDetail: errorMessage(error) });
    await teardownVoice();
    activeSession?.stomp.send("/app/voice.leave", { channelId: channel.id });
  }
}

/**
 * One full connect: fresh /room (the server re-creates a vanished room and mints
 * a fresh Janus token), Janus session, SFU start. A join-time 426 (room vanished)
 * gets exactly ONE retry through a fresh /room — oak's vanished-room recipe.
 */
async function connectVoiceRoom(channel: Channel): Promise<void> {
  const session = activeSession;
  if (!session) {
    throw new Error("no active session");
  }
  let room: RoomInfo = await session.rest.getRoom(channel.id);
  for (let connectAttempt = 0; ; connectAttempt++) {
    janusSessionLostFired = false;
    const janus = new JanusClient({
      baseUrl: room.janusUrl,
      token: room.token,
      pin: room.pin,
      roomId: room.roomId,
      onEvent: (_handleId, event) => sfuSession?.handleEvent(event),
      onJsep: (_handleId, jsep) => {
        if (jsep.type === "offer") {
          void sfuSession?.handleSubscriberOffer(jsep);
        }
      },
      onSessionLost: (reason) => {
        if (janusSessionLostFired) {
          return;
        }
        janusSessionLostFired = true;
        log.warn("voice", `janus session lost: ${reason}`);
        handleVoiceSessionLost(reason);
      },
    });
    janusClient = janus;
    try {
      const publisherHandleId = await janus.open();
      const sfu = new SfuSession({
        room,
        username: appStore.getSnapshot().ownUsername ?? "user",
        janus,
        publisherHandleId,
        mediaSource: navigator.mediaDevices as MediaSource,
        callbacks: {
          onParticipants: (feeds) => {
            appStore.patch({ participants: feeds });
            pruneDeadView(feeds);
          },
          onRemoteTrack: handleRemoteTrack,
          onRemoteTrackEnded: handleRemoteTrackEnded,
          onState: (state, detail) => {
            appStore.patch({ voiceState: state, stateDetail: detail ?? null });
            // The media RTT badge only makes sense on a live transport.
            if (state === "live") {
              startVoiceRttPolling();
            } else {
              stopVoiceRttPolling();
            }
          },
          // The still-muted watchdog's lie detector: a muted publisher sends no RTP,
          // so "silent" is expected for a marked member — only an UNMARKED silent
          // feed is a real fault worth alarming about.
          describeMuteState: (username) => {
            const marks = activeSession?.voiceControlStore.marksFor(username);
            if (!marks || (!marks.selfMuted && !marks.modMuted && !marks.permMuted && !marks.selfDeafened && !marks.modDeafened)) {
              return null;
            }
            const reasons = [
              marks.selfMuted ? "self-muted" : null,
              marks.modMuted ? "server-muted" : null,
              marks.permMuted ? "not allowed to speak" : null,
              marks.selfDeafened ? "self-deafened" : null,
              marks.modDeafened ? "server-deafened" : null,
            ].filter((reason) => reason !== null);
            return reasons.join(", ");
          },
          onError: (error) => {
            if (error instanceof RoomVanishedError) {
              // The room died under a LIVE session — the rejoin ladder owns it now.
              handleVoiceSessionLost("room vanished (426)");
            } else if (error instanceof SubscriberTransportError) {
              // Incoming media died silently (ICE failure on the subscriber PC) — the
              // ladder rebuilds the session, exactly the manual re-click that cured it.
              handleVoiceSessionLost("incoming media transport failed");
            } else if (error instanceof PublisherTransportError) {
              // The M4 subscriber fix's twin: the OUTGOING transport hit ICE failure
              // — without this the bar just read "Connection failed" forever.
              handleVoiceSessionLost("outgoing media transport failed");
            } else {
              log.error("voice", `sfu: ${error.message}`);
              appStore.patch({ stateDetail: error.message });
            }
          },
        },
      });
      sfuSession = sfu;
      sfu.micEnhancer = enhanceMicTrack; // the suppression detour — runs BEFORE the publisher sees a sample
      sfu.microphoneDeviceId = resolvedDevices.microphone;
      await sfu.start();
      const mic = sfu.getMicTrack();
      if (mic) {
        roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", mic);
      }
      applyComplianceToLiveSession(); // a re-entering muted member stays muted
      log.info("voice", `joined room ${room.roomId} on ${room.janusUrl}`);
      return;
    } catch (error) {
      if (error instanceof RoomVanishedError && connectAttempt === 0) {
        log.warn("voice", "room vanished at join (426) — one retry through a fresh /room");
        await teardownVoice();
        room = await session.rest.getRoom(channel.id);
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Voice media RTT (user decision 2026-10-15): the badge's "Voice connected ·
// N ms" reads the MEDIA transport (publisher candidate pair via getStats),
// deliberately distinct from the STOMP ping badge (signalling) — a room can
// be green on signalling while its media path is dead (live 2026-10-14).
// ---------------------------------------------------------------------------

const VOICE_RTT_POLL_MILLIS = 10_000;
let voiceRttTimer: ReturnType<typeof setInterval> | null = null;

function stopVoiceRttPolling(): void {
  if (voiceRttTimer !== null) {
    clearInterval(voiceRttTimer);
    voiceRttTimer = null;
  }
  if (appStore.getSnapshot().voiceRttMillis !== null) {
    appStore.patch({ voiceRttMillis: null });
  }
}

function startVoiceRttPolling(): void {
  stopVoiceRttPolling();
  const poll = async (): Promise<void> => {
    const session = sfuSession;
    if (session === null) {
      stopVoiceRttPolling(); // teardown raced the timer — nothing to read
      return;
    }
    const rtt = await session.getVoiceRttMillis().catch(() => null);
    if (sfuSession === session) { // a stale poll of a replaced session is dropped
      appStore.patch({ voiceRttMillis: rtt });
    }
  };
  void poll(); // the badge gets its number as soon as the pair reports one
  voiceRttTimer = setInterval(() => void poll(), VOICE_RTT_POLL_MILLIS);
}

/**
 * The Janus transport died (network blip, gateway restart, silence watchdog) or the
 * room vanished. Either the channel still exists — climb the rejoin ladder — or it
 * does not and the member is detached for good.
 */
function handleVoiceSessionLost(reason: string): void {
  const state = appStore.getSnapshot();
  if (state.activeVoiceChannelId === null) {
    return; // nothing live — a stale callback from a previous room
  }
  const session = activeSession;
  const channel = session ? session.channelStore.get(state.activeVoiceChannelId) : null;
  if (!session || !channel) {
    void detachVoiceAfterLoss("the channel is gone");
    return;
  }
  if (voiceRejoin === null) {
    voiceRejoin = { channelId: channel.id, attempt: 1, timer: 0 };
    scheduleVoiceRejoin(1, reason);
    return;
  }
  const failedAttempt = voiceRejoin.attempt;
  if (rejoinExhausted(failedAttempt)) {
    void detachVoiceAfterLoss(`could not reconnect after ${failedAttempt} attempts`);
    return;
  }
  voiceRejoin.attempt = failedAttempt + 1;
  scheduleVoiceRejoin(voiceRejoin.attempt, reason);
}

function scheduleVoiceRejoin(attempt: number, reason: string): void {
  const delayMs = rejoinDelayMs(attempt);
  appStore.patch({ voiceState: "reconnecting", stateDetail: `${attempt}/${MAX_VOICE_REJOIN_ATTEMPTS}` });
  log.info("voice", `rejoin attempt ${attempt}/${MAX_VOICE_REJOIN_ATTEMPTS} in ${delayMs} ms (${reason})`);
  const timer = window.setTimeout(() => {
    const rejoin = voiceRejoin;
    const session = activeSession;
    if (!rejoin || !session) {
      return;
    }
    const channel = session.channelStore.get(rejoin.channelId);
    if (!channel) {
      void detachVoiceAfterLoss("the channel is gone");
      return;
    }
    void (async () => {
      try {
        await teardownVoice();
        await connectVoiceRoom(channel);
        // Fresh media flips the state to live via onState; the ladder is done.
        voiceRejoin = null;
        appStore.patch({ stateDetail: "waiting for media" });
        log.info("voice", "rejoin connected");
      } catch (error) {
        log.warn("voice", `rejoin attempt failed: ${errorMessage(error)}`);
        handleVoiceSessionLost(errorMessage(error));
      }
    })();
  }, delayMs);
  if (voiceRejoin !== null) {
    voiceRejoin.timer = timer;
  }
}

/** Full detach after a lost room: teardown, server leave, knock, toast. */
async function detachVoiceAfterLoss(reason: string): Promise<void> {
  cancelVoiceRejoin();
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  const hadSession = sfuSession !== null || janusClient !== null;
  await teardownVoice();
  if (channelId !== null) {
    activeSession?.stomp.send("/app/voice.leave", { channelId });
  }
  resetVoiceCompliance();
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, roomViewOpen: false });
  if (hadSession && settingsStore.getSnapshot().soundEnabled) { // the app sound switch (ding + knocks)
    notifications.playKnock("leave");
    notifications.showToast({ title: "Voice", channelName: "Connection lost", body: `You were disconnected from the room — ${reason}.` });
  }
}

function resetVoiceCompliance(): void {
  voiceCompliance.micMuted = false;
  voiceCompliance.shareAudioMuted = false;
  voiceCompliance.deafened = false;
  roomAudio.setDeafened(false);
}

// ---------------------------------------------------------------------------
// Noise suppression (user decision 2026-09-17): selectable engine over the raw
// mic — RNNoise (default) / DeepFilterNet3 / off. AEC/AGC live on the capture
// constraints and have no knob. The NS button opens oak's engine selector card;
// picking an engine rebuilds the detour and swaps the published track in place
// (no re-capture, no renegotiation).
// ---------------------------------------------------------------------------

/** True while a call is preparing its mic: captureCallMic/wrapCallMic run
 *  BEFORE the PeerCallSession exists (outgoing ring AND accept). The enhance
 *  guard must treat that as a live consumer — see noisePipelineStillWanted. */
let callMicBootInFlight = false;

/** The SfuSession/PeerCallSession mic hook: raw in, published track out. */
async function enhanceMicTrack(rawTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
  disposeNoisePipeline();
  noiseSourceTrack = rawTrack;
  const settings = settingsStore.getSnapshot();
  if (settings.noiseSuppressionEngine === "off") {
    return rawTrack;
  }
  const pipeline = await createNoisePipeline(
    settings.noiseSuppressionEngine,
    rawTrack,
    settings.deepFilterSuppressionLevel,
  );
  // The voice/call may have died while the engine booted — never resurrect it.
  // (A call still PREPARING its mic is alive for this purpose: the session
  // object is created only after the wrap, live 2026-10-15.)
  if (!noisePipelineStillWanted({
    rawTrackLive: rawTrack.readyState === "live",
    voiceSessionAlive: sfuSession !== null,
    callSessionAlive: callSession !== null,
    callMicBootInFlight,
  })) {
    log.warn("ns", `engine ${pipeline.engine} boot dropped — no live consumer`);
    pipeline.dispose();
    return rawTrack;
  }
  activeNoisePipeline = pipeline;
  appliedDeepFilterLevel = settings.deepFilterSuppressionLevel;
  log.info("ns", `engine ${pipeline.engine} live`);
  return pipeline.track;
}

function disposeNoisePipeline(): void {
  if (activeNoisePipeline !== null) {
    log.info("ns", `engine ${activeNoisePipeline.engine} down`);
    activeNoisePipeline.dispose();
    activeNoisePipeline = null;
  }
}

/** Point the live room/call at a mic track (an engine switch): sender swap +
 *  re-bind the speaking analysis, both in place. */
async function publishMicTrack(track: MediaStreamTrack): Promise<void> {
  if (callSession !== null) {
    await callSession.replaceMicTrack(track);
    roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", track);
    return;
  }
  if (sfuSession !== null) {
    await sfuSession.replaceMicTrack(track);
    roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", track);
  }
}

/** Engine switch while voice/call is live: rebuild the detour from the raw
 *  track (kept from enhanceMicTrack) and swap the published track in place. */
async function rebuildNoisePipeline(engine: NoiseEngineKind): Promise<void> {
  const rawTrack = noiseSourceTrack;
  if (rawTrack === null || rawTrack.readyState !== "live") {
    return;
  }
  disposeNoisePipeline();
  let track: MediaStreamTrack;
  if (engine === "off") {
    track = rawTrack;
    log.info("ns", "engine off — publishing the raw mic");
  } else {
    let pipeline: NoisePipeline;
    try {
      pipeline = await createNoisePipeline(engine, rawTrack, settingsStore.getSnapshot().deepFilterSuppressionLevel);
    } catch (error) {
      // The new engine failed to boot — fall back to the RAW track so the
      // sender never keeps the previous (disposed) detour's dead track.
      log.error("ns", `engine ${engine} failed to start: ${errorMessage(error)} — publishing raw`);
      await publishMicTrack(rawTrack);
      return;
    }
    if (rawTrack.readyState !== "live" || (sfuSession === null && callSession === null)) {
      pipeline.dispose();
      return;
    }
    activeNoisePipeline = pipeline;
    appliedDeepFilterLevel = settingsStore.getSnapshot().deepFilterSuppressionLevel;
    track = pipeline.track;
    log.info("ns", `engine ${engine} live`);
  }
  await publishMicTrack(track);
}

/** Live settings follow: an engine pick rebuilds the detour in place. The
 *  rebuild fires for EVERY pick while audio is live — including from "off"
 *  (activeNoisePipeline is null there; an early return on it alone stranded
 *  the raw mic until a re-join — live report). A DFN3 level change reaches
 *  the live worklet through df_set_atten_lim — no rebuild needed. */
function watchNoiseSettings(): void {
  settingsStore.subscribe(() => {
    const { noiseSuppressionEngine, deepFilterSuppressionLevel } = settingsStore.getSnapshot();
    if (activeNoisePipeline !== null && activeNoisePipeline.engine === noiseSuppressionEngine) {
      if (noiseSuppressionEngine === "deepfilternet3" && deepFilterSuppressionLevel !== appliedDeepFilterLevel) {
        activeNoisePipeline.setSuppressionLevel?.(deepFilterSuppressionLevel);
        appliedDeepFilterLevel = deepFilterSuppressionLevel;
        log.info("ns", `suppression level ${deepFilterSuppressionLevel} dB`);
      }
      return;
    }
    if (sfuSession === null && callSession === null) {
      return; // nothing live — the next capture builds whatever is selected
    }
    void rebuildNoisePipeline(noiseSuppressionEngine);
  });
}

export async function teardownVoice(): Promise<void> {
  stopAfkReporting();
  stopVoiceRttPolling();
  feedShareAudioTracks.clear();
  releaseNativeShareAudio();
  watchShareSource(null);
  if (localDisplayStream) {
    for (const track of localDisplayStream.getTracks()) {
      track.stop();
    }
    localDisplayStream = null;
  }
  if (localCameraStream) {
    for (const track of localCameraStream.getTracks()) {
      track.stop();
    }
    localCameraStream = null;
  }
  const session = sfuSession;
  const janus = janusClient;
  sfuSession = null;
  janusClient = null;
  if (session) {
    await session.close().catch(() => undefined);
  }
  if (janus) {
    await janus.destroy().catch(() => undefined);
  }
  disposeNoisePipeline();
  noiseSourceTrack = null;
  roomAudio.detachOwnMic();
  roomAudio.detachAll();
  shareAudioElementActive = false;
  if (appStore.getSnapshot().sharing || appStore.getSnapshot().cameraOn) {
    appStore.patch({ sharing: false, cameraOn: false });
  }
}

export async function leaveVoice(): Promise<void> {
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  cancelVoiceRejoin();
  const hadSession = sfuSession !== null || janusClient !== null;
  await teardownVoice();
  if (channelId !== null) {
    activeSession?.stomp.send("/app/voice.leave", { channelId });
  }
  resetVoiceCompliance();
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, roomViewOpen: false });
  if (hadSession && settingsStore.getSnapshot().soundEnabled) { // the app sound switch (ding + knocks)
    notifications.playKnock("leave");
  }
}

/** The latest delivered remote SHARE AUDIO tracks per feed — a re-watch
 *  re-attaches the RETAINED track: Janus recycles the subscriber m-line,
 *  ontrack never re-fires for the same track object. (Share VIDEO never
 *  arrives here — the pop-out window owns the video subscription.) */
const feedShareAudioTracks = new Map<number, { username: string; track: MediaStreamTrack }>();

function handleRemoteTrack(feedId: number, username: string, kind: RemoteTrackKind, track: MediaStreamTrack): void {
  if (kind === "voice") {
    roomAudio.attachVoiceTrack(feedId, username, track, persistedGain("voice", username));
    return;
  }
  if (kind === "share") {
    feedShareAudioTracks.set(feedId, { username, track });
    roomAudio.attachShareTrack(feedId, username, track, persistedGain("share", username));
    return;
  }
  // Video: wantedStreams no longer subscribes it (the pop-out owns video) —
  // an inbound video track here means that discipline regressed.
  log.warn("sfu", `unexpected inbound video track from ${username} — the pop-out window owns video`);
}

function handleRemoteTrackEnded(feedId: number, _username: string, kind: RemoteTrackKind): void {
  if (kind === "video") {
    return; // never subscribed in the main window (the pop-out owns video)
  }
  if (kind === "share") {
    // Only the share chain — the peer's voice playout must survive a share stop.
    roomAudio.detachShareFeed(feedId);
    return;
  }
  roomAudio.detachFeed(feedId);
}

/** A stopped share disables its streams in the feed ANNOUNCEMENT — every feed
 *  refresh drops the view when the watched feed's video is gone (share stopped)
 *  or the feed itself left. */
function pruneDeadView(feeds: FeedInfo[]): void {
  for (const feedId of feedShareAudioTracks.keys()) {
    if (!feeds.some((entry) => entry.feedId === feedId)) {
      feedShareAudioTracks.delete(feedId);
    }
  }
  const viewed = appStore.getSnapshot().viewingFeedId;
  if (viewed === null) {
    return;
  }
  const feed = feeds.find((entry) => entry.feedId === viewed);
  if (feed === undefined || !feedHasLiveVideo(feed)) {
    appStore.patch({ viewingFeedId: null });
    // The SFU's viewed set must die with the view: a stale entry keeps the
    // feed's share audio in wantedStreams, and the publisher's NEXT share then
    // auto-subscribes — audio playing with nobody pressing Watch (live
    // 2026-09-21: subscriptions +2 the instant a second share landed).
    sfuSession?.setViewingFeed(null);
    dropPopoutWatchTarget();
  }
}

/** A share source picked in the picker modal (M4): screen, window or camera. */
export interface ShareTarget {
  kind: "screen" | "window" | "camera";
  /** desktopCapturer source id, or the camera deviceId for kind="camera". */
  id: string;
  /** The Quality step's decision (2026-09-21): capture caps + the video
   *  sender's bitrate ceiling; width/height null = the uncapped "Source". */
  quality: ShareQuality;
  /** The step-2 audio checkbox — false = a deliberately video-only share. */
  includeAudio: boolean;
}

async function stopCameraLocal(): Promise<void> {
  if (sfuSession) {
    await sfuSession.stopCamera().catch(() => undefined);
  }
  if (localCameraStream) {
    for (const track of localCameraStream.getTracks()) {
      track.stop();
    }
    localCameraStream = null;
  }
  appStore.patch({ cameraOn: false });
}

// Window-share liveness watchdog (the oak SfuService precedent): Chromium
// never fires the capture track's "ended" when the shared window closes — WGC
// freezes the last frame and the ghost share keeps publishing. Main polls
// IsWindow and reports the dead source; the share dies its ORDINARY death.
let watchedShareSource: string | null = null;

function watchShareSource(sourceId: string | null): void {
  watchedShareSource = sourceId;
  void window.spaceCapture?.watchSource(sourceId);
}

function installSourceDeadListener(): void {
  window.spaceCapture?.onSourceDead((sourceId) => {
    if (sourceId !== watchedShareSource) {
      return; // a stale watch from a previous share
    }
    watchedShareSource = null;
    log.info("share", "shared window closed — stopping the share");
    if (appStore.getSnapshot().callSharing) {
      void stopCallShareInternal();
    } else {
      void stopShareInternal();
    }
  });
}

/** The TLS trust dialog's answer to main: Accept stores the session allowance
 *  (main lets the fingerprint through and pins it into the record); Reject
 *  blocks. Either way the prompt closes — the caller decides about a retry. */
export async function decideTlsCertificate(prompt: TlsUntrustedEvent, accept: boolean): Promise<void> {
  try {
    await window.spaceTls?.decide({ hostname: prompt.hostname, fingerprint: prompt.fingerprint, accept });
  } catch (error) {
    log.warn("tls", `certificate decision delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    appStore.patch({ tlsPrompt: null });
  }
}

/** Main reports an untrusted server certificate (TLS entry point, round B) —
 *  surface it for a trust decision. Only the MAIN window gets these. */
function installTlsPromptListener(): void {
  window.spaceTls?.onUntrusted((event) => {
    if (event === null || typeof event !== "object") {
      return;
    }
    const prompt = event as TlsUntrustedEvent;
    if (typeof prompt.hostname !== "string" || typeof prompt.fingerprint !== "string") {
      return;
    }
    log.warn("tls", `untrusted certificate for ${prompt.hostname} (${prompt.changedPinned ? "PIN CHANGED" : "no pin yet"})`);
    appStore.patch({ tlsPrompt: prompt });
  });
}

/** The pop-out window's volume slider remote-controls THIS window's share
 *  playout (the pop-out subscribes video-only — one audible stream). The same
 *  path the roster's member card slider takes: live chain + persisted gain. */
function installPopoutVolumeListener(): void {
  window.spaceWindow?.onPopoutVolume((username, volume) => {
    setShareVolume(username, volume);
  });
}

/** The pop-out window's "closed" signal, installed ONCE at boot (it used to
 *  live in the room view's effect — closing the room view before the pop-out
 *  left popoutActive stuck true forever). */
function installPopoutClosedListener(): void {
  window.spaceWindow?.onClosed(() => popoutClosed());
}

/** Push the voice-panel mirror (mute/deafen glyphs + NS engine) into the
 *  pop-out — called from every point that flips any of them. */
function pushPopoutVoiceState(): void {
  window.spaceWindow?.pushPopoutVoiceState({
    muted: voiceCompliance.micMuted,
    deafened: voiceCompliance.deafened,
    nsEngine: settingsStore.getSnapshot().noiseSuppressionEngine,
  });
}

/** The pop-out's voice-panel buttons duplicate the main panel (user request
 *  2026-09-25): presses run HERE, through the same functions the panel and
 *  the global hotkeys use. */
function installPopoutVoiceActionListener(): void {
  window.spaceWindow?.onPopoutVoiceAction((action, engine) => {
    if (action === "toggle-mute") {
      toggleSelfMute();
    } else if (action === "toggle-deafen") {
      toggleSelfDeafen();
    } else if (action === "ns-engine" && engine !== null) {
      const valid: string[] = ["rnnoise", "deepfilternet3", "dtln", "speex", "gate", "off"];
      if (valid.includes(engine)) {
        settingsStore.apply({ noiseSuppressionEngine: engine as ClientSettings["noiseSuppressionEngine"] });
      }
    }
  });
}

/** Graceful shutdown (live report 2026-09-25: closing the app in a voice room
 *  left ~1min PHANTOM tiles — Janus keeps the dead publisher session until its
 *  own timeout). Main forestalls the window close ~900ms; that window pays for
 *  the explicit exit: SFU/Janus teardown (the destroy HTTP POST is what kills
 *  the feeds for everyone) + the STOMP voice.leave + tearing down a live call.
 *  Fire-and-forget on purpose — the window dies right after either way. */
function installAppClosingListener(): void {
  window.spaceWindow?.onClosing(() => {
    const channelId = appStore.getSnapshot().activeVoiceChannelId;
    teardownCall();
    void teardownVoice().then(() => {
      if (channelId !== null) {
        activeSession?.stomp.send("/app/voice.leave", { channelId });
      }
    }).catch(() => undefined);
  });
}

async function stopShareInternal(): Promise<void> {
  if (sfuSession) {
    await sfuSession.stopShare().catch(() => undefined);
  }
  releaseNativeShareAudio();
  watchShareSource(null);
  if (localDisplayStream) {
    for (const track of localDisplayStream.getTracks()) {
      track.stop();
    }
    localDisplayStream = null;
  }
  appStore.patch({ sharing: false });
}

/** The picker's "Share" — one outgoing video slot: any new share stops the other. */
export async function shareTarget(target: ShareTarget): Promise<void> {
  if (!sfuSession) {
    return;
  }
  try {
    if (target.kind === "camera") {
      if (appStore.getSnapshot().sharing) {
        await stopShareInternal();
      }
      if (appStore.getSnapshot().cameraOn) {
        await stopCameraLocal();
      }
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: target.id }, ...cameraVideoConstraints(target.quality) },
        audio: false,
      });
      localCameraStream = cameraStream;
      await sfuSession.startCamera(cameraStream, target.quality.bitrate);
      appStore.patch({ cameraOn: true });
      log.info("camera", `camera publishing (device ${target.id}, ${describeQuality(target.quality)})`);
      return;
    }
    if (appStore.getSnapshot().cameraOn) {
      await stopCameraLocal();
    }
    if (appStore.getSnapshot().sharing) {
      await stopShareInternal();
    }
    // Tell main which source the NEXT getDisplayMedia grant should hand out; loopback
    // system audio only exists for whole screens and only when the checkbox asked.
    await window.spaceCapture?.select(target.id, target.kind === "screen" && target.includeAudio);
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: displayVideoConstraints(target.quality),
      audio: target.kind === "screen" && target.includeAudio ? LOOPBACK_AUDIO_CONSTRAINTS : false,
    });
    localDisplayStream = display;
    // What Chromium actually granted (the fps/resolution caps are REQUESTS —
    // this line is the ground truth for "did the picker's choice reach the
    // capturer" when a change looks like a no-op on screen).
    const granted = display.getVideoTracks()[0]?.getSettings();
    log.info("share", `capture settings: ${granted?.width ?? "?"}×${granted?.height ?? "?"} @ ${Math.round(granted?.frameRate ?? 0)} fps`);
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void stopShareInternal();
    });
    // Native process-loopback (#485): screens capture the desktop MINUS our
    // process (exclude-self) in place of Chromium's full-desktop loopback — the
    // display stream's own audio track then dies unpublished; windows capture
    // only the target app's process tree (INCLUDE via the source HWND → PID,
    // per-app audio, oak parity) — they carry no Chromium audio at all, so the
    // native track is their only audio and its failure degrades to video-only.
    await stopStandaloneMonitorForShare();
    let publishStream = display;
    const displayAudio = display.getAudioTracks()[0] ?? null;
    const displayVideo = display.getVideoTracks()[0] ?? null;
    // The step-2 checkbox gates the native path wholesale — a video-only share
    // captures no audio at all (screens request none; windows skip the native
    // per-app capture entirely).
    const nativeAudioTrack = target.includeAudio
      ? (target.kind === "window"
        ? await acquireNativeShareAudioTrack(target.id, resolvedDevices.speaker)
        : displayAudio !== null
          ? await acquireNativeShareAudioTrack(undefined, resolvedDevices.speaker)
          : null)
      : null;
    if (nativeAudioTrack !== null && displayAudio !== null && displayVideo !== null) {
      displayAudio.stop();
      publishStream = new MediaStream([displayVideo, nativeAudioTrack]);
    } else if (nativeAudioTrack !== null && displayVideo !== null) {
      publishStream = new MediaStream([displayVideo, nativeAudioTrack]);
    }
    await sfuSession.startShare(publishStream, target.quality.bitrate);
    if (target.kind === "window") {
      watchShareSource(target.id); // ended never fires on window close (WGC)
    }
    const audioDescription = nativeAudioTrack !== null
      ? target.kind === "window"
        ? "native per-app process-loopback"
        : "native process-loopback (desktop minus this client)"
      : target.includeAudio && displayAudio !== null
        ? `raw loopback (channels=${displayAudio.getSettings().channelCount ?? "?"})`
        : "none (checkbox off)";
    log.info("share", `publishing ${target.kind} "${target.id}" (${describeQuality(target.quality)}, audio: ${audioDescription})`);
    appStore.patch({ sharing: true });
  } catch (error) {
    log.error("share", `share failed: ${errorMessage(error)}`);
    releaseNativeShareAudio();
    if (localDisplayStream) {
      for (const track of localDisplayStream.getTracks()) {
        track.stop();
      }
      localDisplayStream = null;
    }
    if (localCameraStream && target.kind === "camera") {
      for (const track of localCameraStream.getTracks()) {
        track.stop();
      }
      localCameraStream = null;
    }
  }
}

/** The camera toggle button — the PICKED device (client settings, oak Video),
 *  falling back to the system default. */
export async function toggleCamera(): Promise<void> {
  if (!sfuSession) {
    return;
  }
  if (appStore.getSnapshot().cameraOn) {
    await stopCameraLocal();
    return;
  }
  const pickedCamera = resolvedDevices.camera;
  try {
    if (appStore.getSnapshot().sharing) {
      await stopShareInternal();
    }
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        ...(pickedCamera !== null ? { deviceId: { exact: pickedCamera } } : {}),
      },
      audio: false,
    });
    localCameraStream = cameraStream;
    await sfuSession.startCamera(cameraStream);
    appStore.patch({ cameraOn: true });
    log.info("camera", `camera publishing (${pickedCamera ?? "default device"})`);
  } catch (error) {
    log.error("camera", `camera failed: ${errorMessage(error)}`);
    if (localCameraStream) {
      for (const track of localCameraStream.getTracks()) {
        track.stop();
      }
      localCameraStream = null;
    }
  }
}

/** The live local camera track — the UI's own preview binds to it. */
export function getCameraTrack(): MediaStreamTrack | null {
  return sfuSession?.getCameraTrack() ?? null;
}

/** The live local share video — the own-tile preview binds to it. */
export function getVoiceShareTrack(): MediaStreamTrack | null {
  return sfuSession?.getShareTrack() ?? null;
}

export function stopShare(): Promise<void> {
  return stopShareInternal();
}

// ---------------------------------------------------------------------------
// Voice control commands (self toggles + moderation)
// ---------------------------------------------------------------------------

/** Self-mute: the toggle reads ONLY the self flag — a moderator's mute is not ours to lift.
 *  The sweep cue lives HERE (user decision): every path to the toggle — the voice-bar
 *  button and the global hotkey alike — announces the new state identically. */
export function toggleSelfMute(): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  // The locked-mute rooms mirror the disabled button for the HOTKEY path: in the AFK
  // room (channel-wide moderator mark) or under the SPEAK permission mute, our unmute
  // changes nothing the room can hear — no frame, and no cue for a non-transition.
  if (session.voiceControlStore.marksFor(session.username()).permMuted
      || session.channelStore.get(channelId)?.afk === true) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(session.username());
  if (settingsStore.getSnapshot().soundEnabled) {
    notifications.playMuteCue(!marks.selfMuted); // the sweep announces the NEW state
  }
  session.sendVoiceControl("/app/voice.mute", channelId, session.username(), { muted: !marks.selfMuted });
}

export function toggleSelfDeafen(): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(session.username());
  if (settingsStore.getSnapshot().soundEnabled) {
    notifications.playDeafenCue(!marks.selfDeafened);
  }
  session.sendVoiceControl("/app/voice.deafen", channelId, session.username(), { deafened: !marks.selfDeafened });
}

/** Moderator actions on another member (the server re-checks permission + hierarchy). */
export function serverMuteUser(username: string): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(username);
  session.sendVoiceControl("/app/voice.mute", channelId, username, { muted: !marks.modMuted });
}

export function serverDeafenUser(username: string): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(username);
  session.sendVoiceControl("/app/voice.deafen", channelId, username, { deafened: !marks.modDeafened });
}

export function kickVoiceUser(username: string): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  session.sendVoiceControl("/app/voice.kick", channelId, username, {});
}

// ---------------------------------------------------------------------------
// Hotkeys (user decision 2026-09-18): GLOBAL chords fire while the window has
// NO focus — mute from a fullscreen game. Two deliberately separate paths: a
// global chord ALWAYS arrives through the OS hook (main → IPC), even when the
// window IS focused; local chords match the window keydown here. Never both —
// a local match for a global action would double-toggle.
// ---------------------------------------------------------------------------

/** The engine to return to when the NS hotkey re-enables suppression. */
let lastNoiseEngine: ClientSettings["noiseSuppressionEngine"] = "rnnoise";

/** off ↔ the last real engine. Commits through the settings store — the existing
 *  watchNoiseSettings rebuilds the LIVE pipeline; nothing here touches audio. */
export function toggleNoiseSuppression(): void {
  const engine = settingsStore.getSnapshot().noiseSuppressionEngine;
  if (engine !== "off") {
    lastNoiseEngine = engine;
  }
  settingsStore.apply({ noiseSuppressionEngine: engine === "off" ? lastNoiseEngine : "off" });
}

/** One step through the sidebar's text channels (Alt+↓/↑ — the Discord walk). */
function stepChannel(delta: 1 | -1): void {
  const state = appStore.getSnapshot();
  const session = activeSession;
  if (!session || state.dmMode) {
    return; // the Home view has no server channels to walk
  }
  const next = adjacentChannelId(session.channelStore.getSnapshot(), state.activeChannelId, delta);
  if (next !== null) {
    setActiveChannel(next);
  }
}

/** The one entry point for BOTH press paths (the OS hook for global chords, the
 *  window keydown for local ones). Unknown ids are silently dropped (a stored
 *  bind from a newer client). */
export function dispatchHotkeyAction(actionId: string): void {
  const state = appStore.getSnapshot();
  switch (actionId) {
    case "toggle-mute": {
      // The sweep cue lives in the toggle functions themselves — the hotkey and
      // the voice-bar button announce the new state identically (user decision).
      const surface = voiceSurfaceFor(state);
      if (surface === "call") {
        toggleCallMic();
      } else if (surface === "room") {
        toggleSelfMute();
      }
      log.info("hotkey", `toggle-mute surface=${surface}`);
      return;
    }
    case "toggle-deafen": {
      const surface = voiceSurfaceFor(state);
      if (surface === "call") {
        toggleCallDeafen();
      } else if (surface === "room") {
        toggleSelfDeafen();
      }
      log.info("hotkey", `toggle-deafen surface=${surface}`);
      return;
    }
    case "toggle-noise-suppression":
      toggleNoiseSuppression();
      log.info("hotkey", `toggle-noise-suppression engine=${settingsStore.getSnapshot().noiseSuppressionEngine}`);
      return;
    case "accept-call":
      callCardAction("accept");
      return;
    case "decline-call":
      callCardAction("decline");
      return;
    case "next-channel":
      stepChannel(1);
      return;
    case "prev-channel":
      stepChannel(-1);
      return;
    case "toggle-search":
      toggleSearch();
      return;
    case "mark-channel-read":
      ackActiveChannel();
      return;
    default:
      return;
  }
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** The window keydown: local-scope chords only. Chords with Ctrl/Alt/Meta fire
 *  everywhere (Alt+↓ must work with the composer focused); a BARE key stays
 *  plain typing inside inputs. preventDefault only for modifier chords — a
 *  browser modifier (the Alt menu) must not flash on top of the action. */
function onKeyDownHotkey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat) {
    return; // a component (the recorder, autocomplete) already consumed it
  }
  const accelerator = acceleratorFromKeyboardEvent(event);
  if (accelerator === null) {
    return;
  }
  const bindings = resolveKeybinds(settingsStore.getSnapshot().keybinds);
  for (const action of KEYBIND_ACTIONS) {
    if (action.scope !== "local" || bindings[action.id] !== accelerator) {
      continue;
    }
    if (isBareKeyAccelerator(accelerator) && isTextEntryTarget(event.target)) {
      return;
    }
    if (!isBareKeyAccelerator(accelerator)) {
      event.preventDefault();
    }
    dispatchHotkeyAction(action.id);
    return;
  }
}

let lastSyncedGlobalChords = "";

/** Pushes the global set to main — but only when it actually changed: unrelated
 *  settings applies emit the store too, and re-registering OS chords on every
 *  toast-TTL tweak is churn for nothing. */
function syncGlobalKeybinds(): void {
  const entries = globalBindingsForSync(resolveKeybinds(settingsStore.getSnapshot().keybinds));
  const payload = JSON.stringify(entries);
  if (payload === lastSyncedGlobalChords) {
    return;
  }
  lastSyncedGlobalChords = payload;
  window.spaceHotkey?.sync(entries)
    .then((status) => keybindStatusStore.setAll(status))
    .catch((error: unknown) => {
      // global mute/deafen would be silently dead — the OS chords never registered
      log.warn("hotkey", `global chord sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** bootstrapApp installs the whole hotkey layer ONCE (never at module top level —
 *  the toast/popout windows bundle this file without bootstrapping it). */
export function installHotkeys(): void {
  window.spaceHotkey?.onHotkey((actionId) => dispatchHotkeyAction(actionId));
  window.addEventListener("keydown", onKeyDownHotkey);
  settingsStore.subscribe(() => syncGlobalKeybinds());
  syncGlobalKeybinds(); // settings load emitted BEFORE this install — catch up now
}

/** Drop every OS chord registration for the duration of a RECORDING. A live
 *  registration swallows the chord at the OS level (RegisterHotKey never
 *  forwards it to the window), so without this the recorder is DEAF to our own
 *  default binds — pressing them did nothing at all (live report). Recording
 *  ends → {@link resumeGlobalHotkeys} re-registers the current set. */
export function suspendGlobalHotkeys(): void {
  window.spaceHotkey?.sync([]).catch(() => undefined);
  lastSyncedGlobalChords = "[]";
}

/** The recording is over — re-register the current set, even though the
 *  canonical payload may equal what flew before the suspend (the detector
 *  alone would skip the invoke and leave the OS chords dead). */
export function resumeGlobalHotkeys(): void {
  lastSyncedGlobalChords = "";
  syncGlobalKeybinds();
}

// ---------------------------------------------------------------------------
// Share pop-out window
// ---------------------------------------------------------------------------

/** The watch that fed the pop-out is over — its target must die with it (the
 *  window holds its OWN Janus subscription and would keep playing, video-only,
 *  after the main window's audio playout died with the unsubscribe).
 *  Runtime-side on purpose: this used to live in a React unmount effect and
 *  was StrictMode-hostile — dev's double mount ran store → cleanup-CLEAR →
 *  skip, killing the target 27 ms after it was pushed (live report 2026-10-05:
 *  the direct-path window sat on "Waiting for the video…" forever). */
function dropPopoutWatchTarget(): void {
  window.spaceWindow?.retargetPopout(null);
}

/** The pop-out window's subscription target for a watched feed (video-only):
 *  the room's connection info + the feed's live video mid. Null (with a log)
 *  when the feed or the room info is not resolvable. */
export function buildPopoutTarget(feedId: number): import("./bridges").PopoutTarget | null {
  const room = getVoiceRoomInfo();
  const feed = appStore.getSnapshot().participants.find((entry) => entry.feedId === feedId);
  const videoMid = feed?.streams.find((stream) => stream.type === "video" && stream.disabled !== true)?.mid;
  if (room === null || feed === undefined || videoMid === undefined) {
    log.warn("popout", `cannot build target for feed ${feedId} (room=${room !== null}, feed=${feed !== undefined}, mid=${videoMid ?? "none"})`);
    return null;
  }
  // feed.display IS the publisher's username — the pop-out's volume slider
  // remote-controls the main window's share playout, persisted per username.
  return {
    janusUrl: room.janusUrl,
    roomId: room.roomId,
    token: room.token,
    pin: room.pin,
    feedId,
    videoMid,
    shareUsername: feed.display,
    shareAudio: feedHasShareAudio(feed),
    shareVolume: persistedGain("share", feed.display),
  };
}

/** Watch a live share in the pop-out window — THE viewing surface (user
 *  requests 2026-10-05: every Watch entry opens the detached window directly).
 *  The main window still owns the subscription — the share audio plays here,
 *  the window renders the video. Closing the window ends the watch
 *  (popoutClosed). */
export async function watchShareInWindow(feedId: number): Promise<void> {
  // The target is built and pushed SYNCHRONOUSLY, BEFORE the window opens:
  // main stores it and the pop-out's mount-time popoutParams() invoke serves
  // it — no React effect races the window spin-up (the StrictMode lesson).
  const target = buildPopoutTarget(feedId);
  if (target === null) {
    return; // nothing to hand to a window — the warn log says why
  }
  // No toggle trap: clicking the glyph of the ALREADY watched feed must focus
  // the existing window, not flip the watch off.
  if (appStore.getSnapshot().viewingFeedId !== feedId) {
    setViewingFeed(feedId);
  }
  window.spaceWindow?.retargetPopout(target);
  appStore.patch({ popoutActive: true });
  const opened = (await window.spaceWindow?.openPopout()) ?? false;
  if (!opened) {
    appStore.patch({ popoutActive: false });
  }
}

export function popoutClosed(): void {
  appStore.patch({ popoutActive: false });
  // The pop-out IS the viewing surface: closing the window ends the watch that
  // fed it (the watch's audio playout lives in THIS window and must not keep
  // playing over nothing).
  const watched = appStore.getSnapshot().viewingFeedId;
  if (watched !== null) {
    setViewingFeed(watched); // toggle-off
  }
}

/** The live voice room's connection info — the pop-out viewer opens its own
 *  subscription against the same room (token/pin included). */
export function getVoiceRoomInfo(): RoomInfo | null {
  return sfuSession?.getRoom() ?? null;
}

// ---------------------------------------------------------------------------
// 1:1 P2P calls (M5) — RING/ACCEPT handshake, PeerCallSession, sounds, exclusivity
// ---------------------------------------------------------------------------

const CALL_VOICE_FEED_ID = -1;
const CALL_SHARE_FEED_ID = -2;

let callSession: PeerCallSession | null = null;
let callMicStream: MediaStream | null = null;
/** The call's mic AFTER the suppression detour (== callMicStream when off). */
let callPublishedMic: MediaStream | null = null;
let callCameraStream: MediaStream | null = null;
let callDisplayStream: MediaStream | null = null;
let ringTimeoutTimer: number | null = null;
let callTickerTimer: number | null = null;
/** The mic state to restore when a self-deafen ends (oak's implied-mute survival). */
let callMicStateBeforeDeafen = true;
/** Signals that raced ahead of the session (OFFER while the callee's mic was still starting). */
const pendingCallSignals: IncomingCallSignal[] = [];

/** A ring that arrived on a NON-active instance (the background-call feature,
 *  #475): the toast-window card tagged with the background server's name, plus
 *  the pending accept that switches the instance before the call comes up. */
let backgroundRing: { recordId: string; peer: string; timer: number | null } | null = null;
/** Set when the user ACCEPTS a background ring — consumed by openSession once
 *  that instance is promoted to the active session. */
let pendingBackgroundAccept: { recordId: string; peer: string } | null = null;

function clearBackgroundRing(): void {
  if (backgroundRing !== null && backgroundRing.timer !== null) {
    window.clearTimeout(backgroundRing.timer);
  }
  backgroundRing = null;
  notifications.dismissCallCard();
}

/** Live voice-invite cards: the toast window's card id → where Join leads. The
 *  entry dies with the button press or a sweep past the card's TTL (the toast
 *  window TTLs the CARD on its own; this keeps the map from leaking). */
const voiceInvites = new Map<number, { recordId: string; channelId: number }>();
let nextVoiceInviteCardId = 1;
/** Set when the user JOINED an invite of a BACKGROUND instance — consumed by
 *  openSession (consumePendingOpen) once that instance is promoted. */
let pendingVoiceJoin: { recordId: string; channelId: number } | null = null;

/** Wiring point for the room view's imperative peer-video element (call mode). */
export const callView = {
  attachPeerVideo(_track: MediaStreamTrack): void {
    // replaced by the call-watch overlay at mount
  },
  dropPeerVideo(): void {
    // replaced by the call-watch overlay at mount
  },
};

/** The peer's live video track — the pane re-binds to it on mount (the <video> element
 *  may not exist yet when the track arrives: CAM_ON races the React render). */
let callPeerVideoTrack: MediaStreamTrack | null = null;

export function getCallPeerVideoTrack(): MediaStreamTrack | null {
  return callPeerVideoTrack;
}

function stopStream(stream: MediaStream | null): void {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

async function captureCallMic(): Promise<MediaStream> {
  // Same policy as the voice room capture: AEC/AGC always on, the built-in
  // suppressor off — the selectable engine owns noise. The pick comes from the
  // RESOLVED devices (the saved hash may be stale across restarts — label
  // recovery in device-match.ts); on OverconstrainedError (a yanked USB mic)
  // fall back to the system default.
  const baseConstraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
  const constraints = resolvedDevices.microphone !== null
    ? { ...baseConstraints, deviceId: { exact: resolvedDevices.microphone } }
    : baseConstraints;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error: unknown) {
    if (resolvedDevices.microphone !== null && error instanceof DOMException && error.name === "OverconstrainedError") {
      log.warn("call", "saved microphone unavailable in this window — using the system default");
      return navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
    }
    throw error;
  }
}

/** The call's publishable mic: the RAW stream through the suppression detour
 *  (one pipeline at a time — a call and a voice room are already exclusive).
 *  callMicStream stays RAW for teardown; this stream feeds the PeerCallSession
 *  and the speaking analysis. */
async function wrapCallMic(raw: MediaStream): Promise<MediaStream> {
  const rawTrack = raw.getAudioTracks()[0] ?? null;
  if (rawTrack === null) {
    return raw;
  }
  const publishedTrack = await enhanceMicTrack(rawTrack);
  return publishedTrack === rawTrack ? raw : new MediaStream([publishedTrack]);
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const config: CallConfig = await activeSession!.rest.getCallConfig();
    return config.iceServers;
  } catch (error) {
    log.warn("call", `call config unavailable (${errorMessage(error)}) — host candidates only`);
    return [];
  }
}

/** The call's own-mic speaking analysis (the self tile's green frame): the same
 *  roomAudio own-mic chain the voice room uses, fed by the call's mic track. */
function attachOwnCallMic(micStream: MediaStream): void {
  const track = micStream.getAudioTracks()[0];
  if (track) {
    roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", track);
  }
}

function callCallbacks(peer: string): PeerCallOptions["callbacks"] {
  return {
    onRemoteTrack: (kind: PeerTrackKind, track: MediaStreamTrack) => {
      if (kind === "voice") {
        roomAudio.attachVoiceTrack(CALL_VOICE_FEED_ID, peer, track, persistedGain("voice", peer));
      } else if (kind === "share") {
        roomAudio.attachShareTrack(CALL_SHARE_FEED_ID, peer, track, persistedGain("share", peer));
      } else {
        callPeerVideoTrack = track;
        callView.attachPeerVideo(track);
      }
    },
    onRemoteTrackEnded: (kind: PeerTrackKind) => {
      if (kind === "voice") {
        roomAudio.detachFeed(CALL_VOICE_FEED_ID);
      } else if (kind === "share") {
        roomAudio.detachFeed(CALL_SHARE_FEED_ID);
      } else {
        callPeerVideoTrack = null;
        callView.dropPeerVideo();
      }
    },
    onPeerMic: (enabled) => appStore.patch({ peerMicOn: enabled }),
    onPeerDeafened: (enabled) => appStore.patch({ peerDeafenedOn: enabled }),
    onPeerCamera: (enabled) => appStore.patch({ peerCameraOn: enabled }),
    onPeerScreen: (enabled) => appStore.patch({ peerScreenOn: enabled }),
    onConnectionHealth: (healthy) => appStore.patch({ callHealthy: healthy }),
    onNegotiated: () => {
      clearRingTimeout(); // the re-armed callee gap (accept→offer) is closed
      notifications.dismissCallCard();
      appStore.patch({ callState: "in-call", callHealthy: true });
      startCallTicker();
      log.info("call", `media up with ${peer}`);
    },
    onError: (message) => log.error("call", message),
  };
}

function handleCallSignal(signal: IncomingCallSignal): void {
  const state = appStore.getSnapshot();
  switch (signal.type) {
    case "RING": {
      if (state.callState === "ringing-in" && state.callPeer === signal.from) {
        return; // redelivery of the SAME ring — the card is already up (oak swallows it too)
      }
      if (state.callState !== "idle") {
        // Busy — the polite auto-reject (oak parity: a duplicate RING never reaches the card).
        activeSession?.sendCallSignal({ type: "REJECT", to: signal.from, sdp: null, candidate: null });
        return;
      }
      appStore.patch({ callState: "ringing-in", callPeer: signal.from, callHealthy: true, callSeconds: 0 });
      if (activeSession !== null) {
        showIncomingCallCard(activeSession, signal.from);
      }
      notifications.playChime();
      armRingTimeout();
      log.info("call", `incoming RING from ${signal.from}`);
      return;
    }
    case "ACCEPT": {
      if (state.callState !== "ringing-out" || state.callPeer !== signal.from) {
        return;
      }
      notifications.stopRingback();
      clearRingTimeout();
      void establishCallerSession(signal.from);
      return;
    }
    case "REJECT": {
      if (state.callState !== "ringing-out" || state.callPeer !== signal.from) {
        return;
      }
      teardownCall();
      notifications.showToast({ title: "Call", channelName: signal.from, body: "Declined your call." });
      return;
    }
    case "HANGUP": {
      if (state.callState === "idle") {
        return;
      }
      teardownCall();
      notifications.showToast({ title: "Call", channelName: signal.from, body: "The call ended." });
      return;
    }
    default: {
      if (callSession !== null) {
        void callSession.handleSignal(signal);
      } else {
        pendingCallSignals.push(signal);
      }
    }
  }
}

function drainPendingCallSignals(): void {
  const queued = [...pendingCallSignals];
  pendingCallSignals.length = 0;
  for (const signal of queued) {
    void callSession?.handleSignal(signal);
  }
}

/** The incoming-call card in the always-on-top TOAST WINDOW (oak's CallOverlay
 *  lived in its own screen-corner stage; ours reuses the toast window). The
 *  avatar paints as the palette-initial fallback FIRST (the card must not wait
 *  on the network), then the real image follows: the toast window is a SEPARATE
 *  renderer context, so neither the roster's presigned URL (it may have aged
 *  out — live report: a broken-image glyph) nor our blob: object URLs cross
 *  over — the image is re-fetched through the attachment cache (fresh-link
 *  recovery included) and re-sent as a data: URL. */
function showIncomingCallCard(callSession: ConnectionSession, peer: string): void {
  const session = callSession;
  // The avatar rides the ROSTER's UserSummary (rosterStore), not ServerMember.
  const users = session.rosterStore.getSnapshot().users;
  const user = users.find((entry) => entry.username === peer) ?? null;
  const serverName = serverDisplayName(session.recordId);
  // The rename model: the card shows the NICKNAME; the login (peer key) never renders.
  const peerName = displayNameOf(users, peer);
  const paint = (avatarUrl: string | null): void => {
    notifications.showCallCard({
      peer: peerName,
      serverName,
      avatarUrl,
      avatarColor: paletteColor(peer),
      status: "Incoming call",
    });
  };
  paint(null);
  // Liveness of THIS ring: the active session's ringing-in state, or — for a
  // BACKGROUND ring — the still-live backgroundRing entry.
  const isStillLive = session === activeSession
    ? () => {
      const state = appStore.getSnapshot();
      return state.callState === "ringing-in" && state.callPeer === peer;
    }
    : () => backgroundRing !== null && backgroundRing.recordId === session.recordId && backgroundRing.peer === peer;
  const avatarKey = user?.avatarKey ?? null;
  const avatarUrl = user?.avatarUrl ?? null;
  if (avatarKey !== null && avatarUrl !== null) {
    // Diagnosed step by step into space.log — a silent catch here left the card
    // on the fallback with nothing to go on (live report).
    void (async () => {
      try {
        const objectUrl = await session.attachmentCache.loadImage({ key: avatarKey, url: avatarUrl });
        log.info("call", `incoming-card avatar cache: ${objectUrl !== null ? "hit" : "null"}`);
        if (objectUrl === null) {
          return;
        }
        const blob = await fetch(objectUrl).then((response) => response.blob());
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        log.info("call", `incoming-card avatar dataUrl: ${dataUrl !== null ? `${Math.round(dataUrl.length / 1024)} KB` : "null"}`);
        // Only while THIS ring is still the live one — a late decode must not
        // resurrect the card or downgrade a "Connecting…" status.
        if (dataUrl !== null && isStillLive()) {
          paint(dataUrl);
        }
      } catch (error) {
        log.warn("call", `incoming-card avatar failed: ${errorMessage(error)}`);
      }
    })();
  } else {
    log.info("call", `incoming-card avatar: no roster image for ${peer} (user=${user !== null}, key=${user?.avatarKey ?? "—"})`);
  }
}

/** One timeout drives all bounded call phases (oak): RINGING_OUT → hang up
 *  ("No answer"), RINGING_IN → missed, and — RE-ARMED on the callee after
 *  Accept — the accept→OFFER gap: a caller that died between the two must not
 *  leave a "Connecting…" card hanging forever. "Off" (0) rings until someone acts. */
function armRingTimeout(): void {
  clearRingTimeout();
  const timeoutSeconds = settingsStore.getSnapshot().ringTimeoutSeconds;
  if (timeoutSeconds <= 0) {
    return; // "Off" — the ring loops until someone acts
  }
  ringTimeoutTimer = window.setTimeout(() => {
    const state = appStore.getSnapshot();
    if (state.callState === "ringing-out") {
      activeSession?.sendCallSignal({ type: "HANGUP", to: state.callPeer ?? "", sdp: null, candidate: null });
      teardownCall();
      notifications.showToast({ title: "Call", channelName: state.callPeer ?? "", body: "No answer." });
    } else if (state.callState === "ringing-in") {
      teardownCall(); // missed call — the caller's own timeout sends HANGUP
    } else if (state.callState === "connecting") {
      teardownCall(); // the callee's re-armed gap: ACCEPT flew, the offer never came
      notifications.showToast({ title: "Call", channelName: state.callPeer ?? "", body: "Could not connect." });
    }
  }, timeoutSeconds * 1000);
}

function clearRingTimeout(): void {
  if (ringTimeoutTimer !== null) {
    window.clearTimeout(ringTimeoutTimer);
    ringTimeoutTimer = null;
  }
}

function startCallTicker(): void {
  stopCallTicker();
  callTickerTimer = window.setInterval(() => {
    const state = appStore.getSnapshot();
    if (state.callState === "in-call" && state.callHealthy) {
      appStore.patch({ callSeconds: state.callSeconds + 1 }); // the timer pauses while reconnecting
    }
  }, 1_000);
}

function stopCallTicker(): void {
  if (callTickerTimer !== null) {
    window.clearInterval(callTickerTimer);
    callTickerTimer = null;
  }
}

/** The "Call" action (roster context menu). Asks about the room conflict first. */
export function callUser(username: string): void {
  const state = appStore.getSnapshot();
  if (!activeSession || state.callState !== "idle") {
    return;
  }
  if (state.activeVoiceChannelId !== null) {
    appStore.patch({ callConflict: { kind: "start-call", peer: username, voiceChannelId: state.activeVoiceChannelId } });
    return;
  }
  void beginOutgoingCall(username);
}

async function beginOutgoingCall(username: string): Promise<void> {
  callMicBootInFlight = true;
  try {
    callMicStream = await captureCallMic();
    callPublishedMic = await wrapCallMic(callMicStream);
  } catch (error) {
    // The toast is short-lived — the full cause must survive in the log (live
    // report: an unreadable error flashed and vanished).
    log.error("call", `outgoing call failed to start: ${errorMessage(error)}`);
    notifications.showToast({ title: "Call", channelName: username, body: `Microphone unavailable — ${errorMessage(error)}` });
    return;
  } finally {
    callMicBootInFlight = false;
  }
  appStore.patch({ callState: "ringing-out", callPeer: username, callHealthy: true, callSeconds: 0 });
  activeSession?.sendCallSignal({ type: "RING", to: username, sdp: null, candidate: null });
  notifications.startRingback();
  armRingTimeout();
  log.info("call", `RING → ${username}`);
}

async function establishCallerSession(peer: string): Promise<void> {
  const session = activeSession;
  const micStream = callPublishedMic ?? callMicStream;
  if (!session || micStream === null) {
    teardownCall();
    return;
  }
  session.playback.stop(); // one audible stream — the call owns the playout now (oak)
  // Like a voice room join: the CHAT STAYS — the call view opens only by an
  // explicit click on the voice bar's status row (user decision).
  appStore.patch({ callState: "connecting" });
  attachOwnCallMic(micStream);
  const iceServers = await fetchIceServers();
  callSession = new PeerCallSession({
    isCaller: true,
    peerUsername: peer,
    iceServers,
    micStream,
    sendSignal: (signal) => session.sendCallSignal(signal),
    callbacks: callCallbacks(peer),
  });
  // Re-announce the pre-accept toggles (the user muted/deafened while the
  // callee was still ringing) — the peer's badges must start truthful.
  if (!callSession.isMicEnabled()) {
    callSession.setMicEnabled(false); // rides MIC_OFF to the peer
  }
  if (roomAudio.isDeafened()) {
    callSession.setDeafened(true); // rides DEAFEN_ON
  }
  drainPendingCallSignals();
  await callSession.startOffer();
}

/** The incoming card's Accept — asks about the room conflict first. */
export function acceptIncomingCall(): void {
  const state = appStore.getSnapshot();
  if (state.callState !== "ringing-in") {
    return;
  }
  if (state.activeVoiceChannelId !== null) {
    appStore.patch({ callConflict: { kind: "accept-call", peer: state.callPeer, voiceChannelId: state.activeVoiceChannelId } });
    return;
  }
  void acceptCallNow();
}

async function acceptCallNow(): Promise<void> {
  const peer = appStore.getSnapshot().callPeer;
  const session = activeSession;
  if (peer === null || !session) {
    teardownCall();
    return;
  }
  clearRingTimeout();
  session.playback.stop(); // one audible stream — the call owns the playout now (oak)
  // Like a voice room join: the CHAT STAYS — the call view opens only by an
  // explicit click on the voice bar's status row (user decision).
  appStore.patch({ callState: "connecting" });
  // oak keeps the card through the accept→OFFER gap — it just stops offering
  // buttons and reads "Connecting…" until the offer lands.
  notifications.updateCallCardStatus("Connecting…");
  callMicBootInFlight = true;
  try {
    callMicStream = await captureCallMic();
    callPublishedMic = await wrapCallMic(callMicStream);
  } catch (error) {
    log.error("call", `accept failed to start: ${errorMessage(error)}`);
    notifications.showToast({ title: "Call", channelName: peer, body: `Microphone unavailable — ${errorMessage(error)}` });
    teardownCall();
    return;
  } finally {
    callMicBootInFlight = false;
  }
  attachOwnCallMic(callPublishedMic ?? callMicStream);
  const iceServers = await fetchIceServers();
  callSession = new PeerCallSession({
    isCaller: false,
    peerUsername: peer,
    iceServers,
    micStream: callPublishedMic ?? callMicStream,
    sendSignal: (signal) => session.sendCallSignal(signal),
    callbacks: callCallbacks(peer),
  });
  session.sendCallSignal({ type: "ACCEPT", to: peer, sdp: null, candidate: null });
  drainPendingCallSignals();
  // The ring timeout re-arms ON THE CALLEE: it now bounds the accept→OFFER gap
  // (a caller that died between the two leaves nothing hanging forever — oak).
  armRingTimeout();
}

export function rejectIncomingCall(): void {
  const state = appStore.getSnapshot();
  if (state.callState !== "ringing-in" || state.callPeer === null) {
    return;
  }
  activeSession?.sendCallSignal({ type: "REJECT", to: state.callPeer, sdp: null, candidate: null });
  teardownCall();
}

/** The incoming card's Accept/Decline semantics — the toast buttons AND the
 *  global hotkey share this one path: the ACTIVE ring answers in place; a
 *  BACKGROUND ring switches the instance first (#475). */
export function callCardAction(action: "accept" | "decline"): void {
  const state = appStore.getSnapshot();
  if (state.callState === "ringing-in") {
    if (action === "accept") {
      acceptIncomingCall();
    } else {
      rejectIncomingCall();
    }
    return;
  }
  if (backgroundRing === null) {
    return;
  }
  const ring = backgroundRing;
  if (action === "accept") {
    // Promote that instance (openSession reuses the live session — no teardown)
    // and hand the ring over; openSession consumes pendingBackgroundAccept.
    pendingBackgroundAccept = { recordId: ring.recordId, peer: ring.peer };
    clearBackgroundRing();
    void switchConnection(ring.recordId);
    return;
  }
  sessionMap.get(ring.recordId)?.sendCallSignal({ type: "REJECT", to: ring.peer, sdp: null, candidate: null });
  clearBackgroundRing();
}

// The toast window's call-card buttons land here (relayed by main).
notifications.setCallActionHandler((action) => callCardAction(action));

/** The voice-invite card (the showIncomingCallCard pattern): paints the palette
 *  initial at once, then chases the roster avatar into a data URL — guarded by
 *  the card still being live (a late decode must not resurrect a joined card). */
function showVoiceInviteCard(inviteSession: ConnectionSession, invite: IncomingVoiceInvite): void {
  const cardId = nextVoiceInviteCardId;
  nextVoiceInviteCardId += 1;
  voiceInvites.set(cardId, { recordId: inviteSession.recordId, channelId: invite.channelId });
  // The map entry outlives the card only briefly — sweep it after the TTL window.
  window.setTimeout(() => voiceInvites.delete(cardId), 70_000);

  const users = inviteSession.rosterStore.getSnapshot().users;
  // The rename model: the card shows the NICKNAME; the wire's `from` login never renders.
  const inviterName = displayNameOf(users, invite.from);
  const serverName = serverDisplayName(inviteSession.recordId);
  const user = users.find((entry) => entry.username === invite.from) ?? null;
  const paint = (avatarUrl: string | null): void => {
    log.info("voice-invite", `painting card id=${cardId} (avatar: ${avatarUrl === null ? "initial" : "dataUrl"})`);
    notifications.showVoiceInviteCard({
      id: cardId,
      inviterName,
      channelName: invite.channelName,
      serverName,
      avatarUrl,
      avatarColor: paletteColor(invite.from),
      dismissSeconds: 60,
    });
  };
  paint(null);
  const avatarKey = user?.avatarKey ?? null;
  const avatarUrl = user?.avatarUrl ?? null;
  if (avatarKey === null || avatarUrl === null) {
    return;
  }
  void (async () => {
    try {
      const objectUrl = await inviteSession.attachmentCache.loadImage({ key: avatarKey, url: avatarUrl });
      if (objectUrl === null) {
        return;
      }
      const blob = await fetch(objectUrl).then((response) => response.blob());
      const dataUrl = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      if (dataUrl !== null && voiceInvites.get(cardId) !== undefined) {
        paint(dataUrl);
      }
    } catch (error) {
      log.warn("voice-invite", `card avatar failed: ${errorMessage(error)}`);
    }
  })();
}

/** Joins the invited room on the given session. Returns false when the gate
 *  failed (no such VOICE channel for this viewer / locked) — the caller falls
 *  through to its ordinary flow. */
function joinInviteChannel(session: ConnectionSession, channelId: number): boolean {
  const channel = session.channelStore.get(channelId);
  if (channel === null || channel.type !== "VOICE" || channel.locked) {
    log.info("voice-invite", `join skipped: channel ${channelId} not joinable for this viewer`);
    return false;
  }
  joinVoiceGuarded(channel); // asks about ending a live call first (the conflict modal)
  return true;
}

/** The invite card's Join/Dismiss semantics: the ACTIVE record joins in place;
 *  a BACKGROUND record switches the instance first (consumePendingOpen joins). */
export function voiceInviteCardAction(action: "join" | "dismiss", cardId: number): void {
  const entry = voiceInvites.get(cardId);
  if (entry === undefined) {
    return;
  }
  voiceInvites.delete(cardId);
  notifications.dismissVoiceInviteCard(cardId);
  if (action !== "join") {
    return;
  }
  if (activeSession !== null && activeSession.recordId === entry.recordId) {
    joinInviteChannel(activeSession, entry.channelId);
    return;
  }
  pendingVoiceJoin = entry;
  void switchConnection(entry.recordId);
}

// The toast window's voice-invite buttons land here (relayed by main).
notifications.setVoiceInviteActionHandler((action, cardId) => voiceInviteCardAction(action, cardId));

export function hangUpCall(): void {
  const state = appStore.getSnapshot();
  if (state.callState === "idle") {
    return;
  }
  if (state.callPeer !== null) {
    activeSession?.sendCallSignal({ type: "HANGUP", to: state.callPeer, sdp: null, candidate: null });
  }
  teardownCall();
}

/** The exclusivity modal's answer. Confirmed transitions leave the room / end the call first. */
export function resolveCallConflict(proceed: boolean): void {
  const conflict = appStore.getSnapshot().callConflict;
  appStore.patch({ callConflict: null });
  if (!conflict || !proceed) {
    return;
  }
  if (conflict.kind === "start-call" && conflict.peer !== null) {
    const peer = conflict.peer;
    void leaveVoice().then(() => void beginOutgoingCall(peer));
    return;
  }
  if (conflict.kind === "accept-call") {
    void leaveVoice().then(() => void acceptCallNow());
    return;
  }
  if (conflict.kind === "join-voice" && conflict.voiceChannelId !== null) {
    hangUpCall();
    const channel = activeSession?.channelStore.get(conflict.voiceChannelId);
    if (channel) {
      void joinVoice(channel);
    }
  }
}

/** A voice-channel click while a call is live — ask before tearing the call down. */
export function joinVoiceGuarded(channel: Channel): void {
  if (appStore.getSnapshot().callState !== "idle") {
    appStore.patch({ callConflict: { kind: "join-voice", peer: appStore.getSnapshot().callPeer, voiceChannelId: channel.id } });
    return;
  }
  void joinVoice(channel);
}

function teardownCall(): void {
  notifications.stopRingback();
  notifications.dismissCallCard();
  clearRingTimeout();
  stopCallTicker();
  if (callSession !== null) {
    callSession.close();
    callSession = null;
  }
  releaseNativeShareAudio();
  watchShareSource(null);
  stopStream(callMicStream);
  stopStream(callCameraStream);
  stopStream(callDisplayStream);
  callMicStream = null;
  callPublishedMic = null;
  disposeNoisePipeline();
  noiseSourceTrack = null;
  callCameraStream = null;
  callDisplayStream = null;
  roomAudio.detachFeed(CALL_VOICE_FEED_ID);
  roomAudio.detachFeed(CALL_SHARE_FEED_ID);
  roomAudio.detachOwnMic();
  roomAudio.setDeafened(false); // call-local deafen dies with the call
  callPeerVideoTrack = null;
  callView.dropPeerVideo();
  pendingCallSignals.length = 0;
  appStore.patch({
    callState: "idle",
    callPeer: null,
    callHealthy: true,
    callSeconds: 0,
    callCameraOn: false,
    callSharing: false,
    callMicOn: true,
    callDeafenedOn: false,
    peerMicOn: true,
    peerDeafenedOn: false,
    peerCameraOn: false,
    peerScreenOn: false,
    // oak's closeCall → restoreChatFromRoom: the call's room view dies with it.
    roomViewOpen: false,
  });
  callMicStateBeforeDeafen = true;
}

export function toggleCallMic(): void {
  const soundOn = settingsStore.getSnapshot().soundEnabled;
  const session = callSession;
  if (session !== null) {
    const next = !session.isMicEnabled();
    if (soundOn) {
      notifications.playMuteCue(next);
    }
    session.setMicEnabled(next);
    appStore.patch({ callMicOn: next });
    return;
  }
  // Pre-accept (ringing-out): the mic is ALREADY captured — gate the track
  // directly; the PeerCallSession inherits the gate (its micEnabled reads the
  // track) and re-announces it to the peer once the offer flies. Gate the
  // PUBLISHED track — with an engine live it is the one the sender will carry.
  const track = callPublishedMic?.getAudioTracks()[0] ?? callMicStream?.getAudioTracks()[0] ?? null;
  if (track) {
    track.enabled = !track.enabled;
    if (soundOn) {
      notifications.playMuteCue(!track.enabled);
    }
    appStore.patch({ callMicOn: track.enabled });
  }
}

export function isCallMicEnabled(): boolean {
  return callSession?.isMicEnabled() ?? true;
}

/**
 * Call-local deafen (oak semantics): silence OUR playout AND gate the mic — a
 * deafened member must not keep broadcasting. The pre-deafen mic state returns on
 * undeafen; MIC_OFF/ON + DEAFEN signals keep the peer's badges truthful.
 */
export function toggleCallDeafen(): void {
  const session = callSession;
  const nowDeafened = !roomAudio.isDeafened();
  if (settingsStore.getSnapshot().soundEnabled) {
    notifications.playDeafenCue(nowDeafened);
  }
  roomAudio.setDeafened(nowDeafened);
  if (session === null) {
    appStore.patch({ callDeafenedOn: nowDeafened });
    return;
  }
  if (nowDeafened) {
    callMicStateBeforeDeafen = session.isMicEnabled();
    if (callMicStateBeforeDeafen) {
      session.setMicEnabled(false); // rides MIC_OFF to the peer
    }
  } else if (callMicStateBeforeDeafen) {
    session.setMicEnabled(true);
  }
  session.setDeafened(nowDeafened);
  appStore.patch({ callDeafenedOn: nowDeafened, callMicOn: session.isMicEnabled() });
}

export async function toggleCallCamera(): Promise<void> {
  const session = callSession;
  if (session === null) {
    return;
  }
  if (session.isCameraActive()) {
    await session.setCameraStream(null);
    stopStream(callCameraStream);
    callCameraStream = null;
    appStore.patch({ callCameraOn: false });
    return;
  }
  const pickedCamera = resolvedDevices.camera;
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        ...(pickedCamera !== null ? { deviceId: { exact: pickedCamera } } : {}),
      },
      audio: false,
    });
    await session.setCameraStream(cameraStream);
    callCameraStream = cameraStream;
    appStore.patch({ callCameraOn: true });
  } catch (error) {
    log.error("call", `camera failed: ${errorMessage(error)}`);
  }
}

/** The LOCAL video track for the self tile — the camera OR the shared screen. */
export function getCallLocalVideoTrack(): MediaStreamTrack | null {
  return callCameraStream?.getVideoTracks()[0] ?? callDisplayStream?.getVideoTracks()[0] ?? null;
}

async function stopCallShareInternal(): Promise<void> {
  await callSession?.stopShare();
  releaseNativeShareAudio();
  watchShareSource(null);
  stopStream(callDisplayStream);
  callDisplayStream = null;
  appStore.patch({ callSharing: false });
}

/** The share picker's target inside a call (screen/window swap the video slot, screens carry stereo audio). */
export async function callShareTarget(target: ShareTarget): Promise<void> {
  const session = callSession;
  if (session === null) {
    return;
  }
  try {
    if (target.kind === "camera") {
      if (session.isSharing()) {
        await stopCallShareInternal();
      }
      stopStream(callCameraStream);
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: target.id }, ...cameraVideoConstraints(target.quality) },
        audio: false,
      });
      await session.setCameraStream(cameraStream, target.quality.bitrate);
      callCameraStream = cameraStream;
      appStore.patch({ callCameraOn: true });
      return;
    }
    if (session.isSharing()) {
      await stopCallShareInternal();
    }
    if (appStore.getSnapshot().callCameraOn) {
      await toggleCallCamera();
    }
    await window.spaceCapture?.select(target.id, target.kind === "screen" && target.includeAudio);
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: displayVideoConstraints(target.quality),
      audio: target.kind === "screen" && target.includeAudio ? LOOPBACK_AUDIO_CONSTRAINTS : false,
    });
    callDisplayStream = display;
    const granted = display.getVideoTracks()[0]?.getSettings();
    log.info("call", `share capture settings: ${granted?.width ?? "?"}×${granted?.height ?? "?"} @ ${Math.round(granted?.frameRate ?? 0)} fps`);
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void stopCallShareInternal();
    });
    // Same native substitution as the room seam (#485): screens exclude our
    // process (desktop minus this client), windows capture only the target
    // app's tree (per-app INCLUDE). Failure falls back to the raw/no audio;
    // the step-2 checkbox gates the native path wholesale (video-only share).
    await stopStandaloneMonitorForShare();
    let publishStream = display;
    const displayAudio = display.getAudioTracks()[0] ?? null;
    const displayVideo = display.getVideoTracks()[0] ?? null;
    const nativeAudioTrack = target.includeAudio
      ? (target.kind === "window"
        ? await acquireNativeShareAudioTrack(target.id, resolvedDevices.speaker)
        : displayAudio !== null
          ? await acquireNativeShareAudioTrack(undefined, resolvedDevices.speaker)
          : null)
      : null;
    if (nativeAudioTrack !== null && displayAudio !== null && displayVideo !== null) {
      displayAudio.stop();
      publishStream = new MediaStream([displayVideo, nativeAudioTrack]);
    } else if (nativeAudioTrack !== null && displayVideo !== null) {
      publishStream = new MediaStream([displayVideo, nativeAudioTrack]);
    }
    await session.startShare(publishStream, target.quality.bitrate);
    if (target.kind === "window") {
      watchShareSource(target.id); // ended never fires on window close (WGC)
    }
    const audioDescription = nativeAudioTrack !== null
      ? target.kind === "window"
        ? "native per-app process-loopback"
        : "native process-loopback"
      : target.includeAudio && displayAudio !== null
        ? "raw loopback"
        : "none (checkbox off)";
    log.info("call", `share publishing ${target.kind} (${describeQuality(target.quality)}, audio: ${audioDescription})`);
    appStore.patch({ callSharing: true });
  } catch (error) {
    log.error("call", `call share failed: ${errorMessage(error)}`);
    releaseNativeShareAudio();
    stopStream(callDisplayStream);
    callDisplayStream = null;
  }
}

export function stopCallShare(): Promise<void> {
  return stopCallShareInternal();
}

export function toggleTestTone(channel: "left" | "right"): void {
  if (roomAudio.getTestToneChannel() === channel) {
    roomAudio.stopStereoTestTone();
  } else {
    roomAudio.startStereoTestTone(channel);
  }
  appStore.patch({ testToneChannel: roomAudio.getTestToneChannel() });
}

/** Per-user gains now live in the CONNECTION RECORD (per-server, survives re-login). */
export function persistedGain(kind: "voice" | "share", username: string): number {
  const record = activeSession ? connectionDirectory.get(activeSession.recordId) : null;
  if (!record) {
    return 1;
  }
  const volumes = kind === "voice" ? record.voiceVolumes : record.shareVolumes;
  const stored = volumes[username];
  return typeof stored === "number" && Number.isFinite(stored) ? stored : 1;
}

export function setVoiceVolume(username: string, gain: number): void {
  roomAudio.setVoiceVolume(username, gain);
  if (activeSession) {
    connectionDirectory.setVolume(activeSession.recordId, "voice", username, gain);
  }
  volumeChanges.publish({ kind: "voice", username, gain, nonce: volumeChangeNonce++ });
}

export function setShareVolume(username: string, gain: number): void {
  roomAudio.setShareVolume(username, gain);
  if (activeSession) {
    connectionDirectory.setVolume(activeSession.recordId, "share", username, gain);
  }
  volumeChanges.publish({ kind: "share", username, gain, nonce: volumeChangeNonce++ });
  window.spaceWindow?.pushPopoutVolume(username, gain); // the pop-out slider follows
}

/** Live volume-change feed: an open member card's sliders follow changes made
 *  ANYWHERE (the pop-out's slider, another card) — VolumeRow is otherwise a
 *  snapshot of initialGain. */
export interface VolumeChange {
  kind: "voice" | "share";
  username: string;
  gain: number;
  nonce: number;
}

class VolumeChangesStore extends Emitter {
  private state: VolumeChange | null = null;
  getSnapshot = (): VolumeChange | null => this.state;
  publish(change: VolumeChange): void {
    this.state = change;
    this.emit();
  }
}

let volumeChangeNonce = 0;
export const volumeChanges = new VolumeChangesStore();

export function setViewingFeed(feedId: number | null): void {
  const next = appStore.getSnapshot().viewingFeedId === feedId ? null : feedId;
  appStore.patch({ viewingFeedId: next });
  sfuSession?.setViewingFeed(next);
  if (next === null) {
    dropPopoutWatchTarget();
    return;
  }
  // A recycled m-line never re-fires ontrack: re-attach the retained share
  // audio immediately (the video lives in the pop-out window's own
  // subscription; a genuinely fresh track delivery rebuilds the chain anyway).
  const retainedAudio = feedShareAudioTracks.get(next);
  if (retainedAudio) {
    roomAudio.attachShareTrack(next, retainedAudio.username, retainedAudio.track, persistedGain("share", retainedAudio.username));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics model (built on the 4 Hz tick driven by the Diagnostics component)
// ---------------------------------------------------------------------------
export interface DiagModel {
  lines: { key: string; value: string }[];
  stereo: { leftDbfs: number; rightDbfs: number; deltaDb: number; channelCount: number } | null;
  stereoVerdict: "PASS" | "MONO" | "SILENT" | null;
}

let inboundAudioLine = "—";
window.setInterval(() => {
  void sfuSession?.getInboundAudioLine().then((line) => {
    inboundAudioLine = line;
  });
}, 1_000);

let lastLoggedVerdict: string | null = null;

// ---------------------------------------------------------------------------
// Share-video telemetry (the diag "share out/in" lines): "the viewer sees it
// choppy" reports get NUMBERS. Publisher side: capture input fps vs ENCODED
// fps (input 75 while enc ≈ 20 = the encoder cannot keep up — CPU, not
// network). Viewer side: decoded fps, dropped frames, loss, jitter. getStats
// is async, so a 1 Hz poller feeds a cached string the 4 Hz diag panel reads;
// it starts lazily with the first diag model build (panel open) and every
// 10th tick lands in [share-stats] for post-mortems.
// ---------------------------------------------------------------------------

let shareStatsTimer: ReturnType<typeof setInterval> | null = null;
let shareStatsTicks = 0;
let lastOutCounters: VideoRtpCounters | null = null;
const shareStatsCache = { out: "—" };

/** The publisher-side share line (input fps vs ENCODED fps — enc ≪ in = the
 *  encoder cannot keep up). The old viewer-side "share in" line is GONE: the
 *  main window no longer subscribes the watched share's video (2026-10-05,
 *  the pop-out owns it), so there is no inbound track to read stats from. */
function shareStatsLine(current: VideoRtpCounters | null, previous: VideoRtpCounters | null): string {
  if (current === null) {
    return "—";
  }
  const dimensions = current.width !== null && current.height !== null ? `${current.width}×${current.height}` : "?";
  const parts = [dimensions, `in ${current.framesPerSecond ?? "?"} fps`];
  if (previous !== null) {
    const seconds = Math.max(0.001, (current.timestamp - previous.timestamp) / 1000);
    if (current.frames >= previous.frames) {
      parts.push(`enc ${((current.frames - previous.frames) / seconds).toFixed(0)} fps`);
    }
    if (current.bytes >= previous.bytes) {
      parts.push(`${(((current.bytes - previous.bytes) * 8 / seconds) / 1_000_000).toFixed(1)} Mbps`);
    }
  }
  return parts.join(" · ");
}

async function pollShareStats(): Promise<void> {
  let outCounters: VideoRtpCounters | null = null;
  try {
    outCounters = sfuSession !== null ? await sfuSession.getShareOutCounters() : null;
  } catch {
    outCounters = null;
  }
  shareStatsCache.out = shareStatsLine(outCounters, lastOutCounters);
  lastOutCounters = outCounters;

  shareStatsTicks += 1;
  if (shareStatsTicks % 10 === 0 && outCounters !== null) {
    log.info("share-stats", `out: ${shareStatsCache.out}`);
  }
}

function ensureShareStatsPoller(): void {
  if (shareStatsTimer === null) {
    shareStatsTimer = setInterval(() => void pollShareStats(), 1000);
  }
}

export function buildDiagModel(): DiagModel {
  const state = appStore.getSnapshot();
  const sentSdp = sfuSession?.getPublisherLocalSdp();
  const sentLine = sentSdp
    ? extractAudioFmtpLines(sentSdp).map((line) => `m${line.mindex}: ${line.fmtp ?? "—"}`).join(" | ")
    : null;
  const wireSdp = sfuSession?.getLastSubscriberOfferSdp();
  const wireLine = wireSdp
    ? extractAudioFmtpLines(wireSdp).map((line) => `m${line.mindex}: ${line.fmtp ?? "—"}`).join(" | ")
    : null;

  const probeTarget = state.participants.find((feed) => state.viewingFeedId === feed.feedId)?.display ?? null;
  const reading = probeTarget ? roomAudio.stereoProbe(probeTarget) : null;
  const verdict = reading ? stereoVerdict(reading) : null;
  if (verdict !== null && verdict !== lastLoggedVerdict) {
    lastLoggedVerdict = verdict;
    const dominant = reading
      ? reading.leftDbfs - reading.rightDbfs > 6 ? " (signal LEFT)"
        : reading.rightDbfs - reading.leftDbfs > 6 ? " (signal RIGHT)" : ""
      : "";
    log.info("oracle",
      `verdict ${verdict}${dominant}: L=${reading?.leftDbfs.toFixed(1)} R=${reading?.rightDbfs.toFixed(1)}`
      + ` Δ=${reading?.deltaDb.toFixed(1)} ch=${reading?.channelCount} (target "${probeTarget}")`);
  }

  const nsSettings = settingsStore.getSnapshot();
  const nsLine = `${nsSettings.noiseSuppressionEngine}`
    + (activeNoisePipeline !== null
      ? " live" + (activeNoisePipeline.vad !== null ? ` vad ${activeNoisePipeline.vad.toFixed(2)}` : "")
      : " (idle)");
  ensureShareStatsPoller();
  return {
    lines: [
      { key: "stomp", value: state.stompState },
      { key: "audio ctx", value: roomAudio.getState() },
      { key: "ns", value: nsLine },
      { key: "voice", value: state.voiceState + (state.activeVoiceChannelId !== null ? ` #${state.activeVoiceChannelId}` : "") },
      { key: "call", value: state.callState !== "idle" ? `${state.callState} → ${state.callPeer ?? "?"} (${state.callHealthy ? "healthy" : "reconnecting"})` : "—" },
      { key: "sub conn", value: sfuSession?.getSubscriberConnectionState() ?? "—" },
      { key: "subs", value: String(sfuSession?.getSubscribedCount() ?? 0) },
      { key: "share out", value: shareStatsCache.out },
      { key: "inbound", value: inboundAudioLine },
      { key: "sent fmtp", value: sentLine ?? "—" },
      { key: "wire fmtp", value: wireLine ?? "—" },
      { key: "user", value: state.ownUsername ?? "—" },
      { key: "vscroll", value: `${Math.round(virtualScrollTelemetry.scrollTop)}/${Math.round(virtualScrollTelemetry.scrollHeight)} (${(virtualScrollTelemetry.thumbFraction * 100).toFixed(0)}%)` },
    ],
    stereo: reading,
    stereoVerdict: verdict,
  };
}

void shareAudioElementActive;
