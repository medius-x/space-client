import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { LocalTokenStorage, type TokenStorage } from "../core/auth";
import { RestClient } from "../core/rest";
import { StompClient } from "../core/stomp";
import { JanusClient } from "../core/janus";
import { SfuSession, RoomVanishedError, type MediaSource } from "../core/sfu";
import { extractAudioFmtpLines } from "../core/sdp";
import { stereoVerdict } from "../core/audio-math";
import { RoomAudio } from "../media/RoomAudio";
import type {
  Channel,
  FeedInfo,
  PresenceEvent,
  RemoteTrackKind,
  RoomInfo,
  UserSummary,
  VoiceMemberEvent,
  VoiceRoomState,
} from "../types";

/**
 * The application runtime — a MODULE SINGLETON, deliberately outside the React tree:
 * Fast Refresh only reloads components, so editing UI code never tears down WebRTC,
 * STOMP sessions or the audio graph (edits to this file cost a full reload — same as
 * the spike's esbuild loop). This is the M0 port of the spike's src/main.ts; M1 splits
 * it into ConnectionSession + stores.
 */

export interface AppState {
  screen: "login" | "main";
  loginError: string | null;
  loginBusy: boolean;
  ownUsername: string | null;
  baseUrl: string;
  channels: Channel[];
  users: UserSummary[];
  presence: ReadonlySet<string>;
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
  activeVoiceChannelId: number | null;
  voiceState: VoiceRoomState;
  stateDetail: string | null;
  participants: FeedInfo[];
  sharing: boolean;
  testToneChannel: "left" | "right" | null;
  apmEnabled: boolean;
  viewingFeedId: number | null;
  viewingUsername: string | null;
  diagOpen: boolean;
  stompState: "off" | "connecting" | "connected" | "lost";
}

class AppStore extends Emitter {
  private state: AppState = {
    screen: "login",
    loginError: null,
    loginBusy: false,
    ownUsername: null,
    baseUrl: "",
    channels: [],
    users: [],
    presence: new Set<string>(),
    voiceMembers: new Map<number, ReadonlySet<string>>(),
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    participants: [],
    sharing: false,
    testToneChannel: null,
    apmEnabled: true,
    viewingFeedId: null,
    viewingUsername: null,
    diagOpen: true,
    stompState: "off",
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
const tokenStorage: TokenStorage = new LocalTokenStorage();

/** Live session objects — created at login, torn down at expiry/logout. */
let restClient: RestClient | null = null;
let stompClient: StompClient | null = null;
let janusClient: JanusClient | null = null;
let sfuSession: SfuSession | null = null;
let localDisplayStream: MediaStream | null = null;
let janusSessionLostFired = false;
let shareAudioElementActive = false;

/** Wiring point for the imperative voice view (tiles/meters) — set by VoiceRoom. */
export const voiceView = {
  attachShareVideo(username: string, track: MediaStreamTrack): void {
    void username; void track;
  },
  dropShareVideo(): void {
    // replaced by VoiceRoom at mount
  },
  onSpeaking(username: string, speaking: boolean): void {
    void username; void speaking;
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws") + "/ws";
}

function persistedGain(kind: "voice" | "share", username: string): number {
  return Number(localStorage.getItem(`space.vol.${kind}.${username}`) ?? 100) / 100;
}

// ---------------------------------------------------------------------------
// Display-media self-test (risk probe from the spike)
// ---------------------------------------------------------------------------
export async function runDisplayMediaSelfTest(): Promise<void> {
  log.info("selftest", "getDisplayMedia({video:true, audio:{channelCount:{ideal:2}}})…");
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: { ideal: 2 } },
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
// Session (login → REST → STOMP)
// ---------------------------------------------------------------------------
export async function startSession(baseUrl: string, mode: "login" | "register", username: string, password: string): Promise<void> {
  const client = new RestClient({
    baseUrl,
    tokenStorage,
    onSessionExpired: () => {
      log.warn("app", "session expired — back to login");
      void teardownSession();
      appStore.patch({ screen: "login", loginError: "Session expired — log in again" });
    },
  });
  appStore.patch({ loginBusy: true, loginError: null });
  try {
    if (mode === "login") {
      await client.login(username, password);
    } else {
      await client.register(username, password);
    }
    const [channels, users, presence, voiceMembers] = await Promise.all([
      client.getChannels(),
      client.getUsers(),
      client.getPresence(),
      client.getVoiceMembers(),
    ]);

    restClient = client;
    const stomp = new StompClient({
      url: toWsUrl(baseUrl),
      getAccessToken: () => tokenStorage.load()?.token ?? "",
      handlers: {
        onLost: (reason) => {
          log.warn("app", `STOMP lost: ${reason} (auto-reconnecting)`);
          appStore.patch({ stompState: "lost" });
        },
        onConnected: () => {
          appStore.patch({ stompState: "connected" });
          const channelId = appStore.getSnapshot().activeVoiceChannelId;
          if (channelId !== null) {
            stomp.send("/app/voice.join", { channelId });
          }
        },
      },
    });
    stompClient = stomp;
    appStore.patch({ stompState: "connecting" });
    await stomp.connect();
    stomp.subscribe("/topic/presence", (raw) => applyPresenceEvent(JSON.parse(raw) as PresenceEvent));
    stomp.subscribe("/topic/voice", (raw) => applyVoiceEvent(JSON.parse(raw) as VoiceMemberEvent));

    roomAudio.setSpeakingHandler((username_, speaking) => {
      voiceView.onSpeaking(username_, speaking);
    });
    roomAudio.startLevelPolling();

    appStore.patch({
      screen: "main",
      baseUrl,
      ownUsername: username,
      channels,
      users,
      presence: new Set(presence),
      voiceMembers: new Map(voiceMembers.map((entry) => [entry.channelId, new Set(entry.usernames)])),
    });
    await roomAudio.resume();
    log.info("app", `session up: ${username} @ ${baseUrl} (${channels.length} channels)`);
  } catch (error) {
    appStore.patch({ loginError: errorMessage(error) });
  } finally {
    appStore.patch({ loginBusy: false });
  }
}

export async function teardownSession(): Promise<void> {
  await teardownVoice();
  roomAudio.stopLevelPolling();
  roomAudio.detachOwnMic();
  stompClient?.disconnect();
  stompClient = null;
  restClient = null;
  appStore.patch({
    stompState: "off",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    participants: [],
    sharing: false,
    viewingFeedId: null,
    viewingUsername: null,
  });
}

function applyPresenceEvent(event: PresenceEvent): void {
  const presence = new Set(appStore.getSnapshot().presence);
  if (event.status === "ONLINE") {
    presence.add(event.username);
  } else {
    presence.delete(event.username);
  }
  appStore.patch({ presence });
}

function applyVoiceEvent(event: VoiceMemberEvent): void {
  const voiceMembers = new Map(appStore.getSnapshot().voiceMembers);
  const current = new Set(voiceMembers.get(event.channelId) ?? []);
  if (event.status === "JOINED") {
    current.add(event.username);
  } else {
    current.delete(event.username);
  }
  voiceMembers.set(event.channelId, current);
  appStore.patch({ voiceMembers });
  log.info("voice", `${event.username} ${event.status.toLowerCase()} channel #${event.channelId}`);
}

// ---------------------------------------------------------------------------
// Voice session (room → Janus → SFU)
// ---------------------------------------------------------------------------
export async function joinVoice(channel: Channel): Promise<void> {
  if (!restClient) {
    return;
  }
  await teardownVoice();
  appStore.patch({ activeVoiceChannelId: channel.id, voiceState: "connecting", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null });

  let room: RoomInfo;
  try {
    room = await restClient.getRoom(channel.id);
  } catch (error) {
    appStore.patch({ voiceState: "failed", stateDetail: errorMessage(error) });
    return;
  }
  stompClient?.send("/app/voice.join", { channelId: channel.id });

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
      appStore.patch({ voiceState: "reconnecting", stateDetail: `${reason} — re-click the channel (ladder lands in M4)` });
    },
  });
  janusClient = janus;

  try {
    const publisherHandleId = await janus.open();
    const session = new SfuSession({
      room,
      username: appStore.getSnapshot().ownUsername ?? "user",
      janus,
      publisherHandleId,
      mediaSource: navigator.mediaDevices as MediaSource,
      callbacks: {
        onParticipants: (feeds) => appStore.patch({ participants: feeds }),
        onRemoteTrack: handleRemoteTrack,
        onRemoteTrackEnded: handleRemoteTrackEnded,
        onState: (state, detail) => appStore.patch({ voiceState: state, stateDetail: detail ?? null }),
        onError: (error) => {
          if (error instanceof RoomVanishedError) {
            appStore.patch({ voiceState: "failed", stateDetail: "room vanished — re-click the channel" });
          } else {
            log.error("voice", `sfu: ${error.message}`);
            appStore.patch({ stateDetail: error.message });
          }
        },
      },
    });
    sfuSession = session;
    await session.start();
    const mic = session.getMicTrack();
    if (mic) {
      roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", mic);
    }
    log.info("voice", `joined room ${room.roomId} on ${room.janusUrl}`);
  } catch (error) {
    appStore.patch({ voiceState: "failed", stateDetail: errorMessage(error) });
    await teardownVoice();
    stompClient?.send("/app/voice.leave", { channelId: channel.id });
  }
}

export async function teardownVoice(): Promise<void> {
  voiceView.dropShareVideo();
  if (localDisplayStream) {
    for (const track of localDisplayStream.getTracks()) {
      track.stop();
    }
    localDisplayStream = null;
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
  roomAudio.detachOwnMic();
  roomAudio.detachAll();
  shareAudioElementActive = false;
}

export async function leaveVoice(): Promise<void> {
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  await teardownVoice();
  if (channelId !== null) {
    stompClient?.send("/app/voice.leave", { channelId });
  }
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", participants: [], viewingFeedId: null, viewingUsername: null });
}

function handleRemoteTrack(feedId: number, username: string, kind: RemoteTrackKind, track: MediaStreamTrack): void {
  if (kind === "voice") {
    roomAudio.attachVoiceTrack(feedId, username, track, persistedGain("voice", username));
    return;
  }
  if (kind === "share") {
    roomAudio.attachShareTrack(feedId, username, track, persistedGain("share", username));
    return;
  }
  if (appStore.getSnapshot().viewingFeedId === feedId) {
    appStore.patch({ viewingUsername: username });
    voiceView.attachShareVideo(username, track);
  }
}

function handleRemoteTrackEnded(feedId: number, _username: string, kind: RemoteTrackKind): void {
  if (kind === "video") {
    voiceView.dropShareVideo();
    appStore.patch({ viewingUsername: null });
    return;
  }
  roomAudio.detachFeed(feedId);
}

export async function toggleShare(): Promise<void> {
  if (!sfuSession) {
    return;
  }
  if (appStore.getSnapshot().sharing) {
    await sfuSession.stopShare().catch(() => undefined);
    if (localDisplayStream) {
      for (const track of localDisplayStream.getTracks()) {
        track.stop();
      }
      localDisplayStream = null;
    }
    appStore.patch({ sharing: false });
    return;
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: { ideal: 2 } },
    });
    localDisplayStream = display;
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void toggleShare();
    });
    await sfuSession.startShare(display);
    const shareAudio = display.getAudioTracks()[0];
    log.info("share", `publishing share (audio channels=${shareAudio ? shareAudio.getSettings().channelCount ?? "?" : "none"})`);
    appStore.patch({ sharing: true });
  } catch (error) {
    log.error("share", `share failed: ${errorMessage(error)}`);
    if (localDisplayStream) {
      for (const track of localDisplayStream.getTracks()) {
        track.stop();
      }
      localDisplayStream = null;
    }
  }
}

export function toggleTestTone(channel: "left" | "right"): void {
  if (roomAudio.getTestToneChannel() === channel) {
    roomAudio.stopStereoTestTone();
  } else {
    roomAudio.startStereoTestTone(channel);
  }
  appStore.patch({ testToneChannel: roomAudio.getTestToneChannel() });
}

export function setVoiceVolume(username: string, gain: number): void {
  roomAudio.setVoiceVolume(username, gain);
  localStorage.setItem(`space.vol.voice.${username}`, String(Math.round(gain * 100)));
}

export function setShareVolume(username: string, gain: number): void {
  roomAudio.setShareVolume(username, gain);
  localStorage.setItem(`space.vol.share.${username}`, String(Math.round(gain * 100)));
}

export function setViewingFeed(feedId: number | null): void {
  const next = appStore.getSnapshot().viewingFeedId === feedId ? null : feedId;
  appStore.patch({ viewingFeedId: next, viewingUsername: null });
  sfuSession?.setViewingFeed(next);
  if (next === null) {
    voiceView.dropShareVideo();
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

  const probeTarget = state.viewingUsername
    ?? state.participants.find((feed) => state.viewingFeedId === feed.feedId)?.display
    ?? null;
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

  return {
    lines: [
      { key: "stomp", value: state.stompState },
      { key: "audio ctx", value: roomAudio.getState() },
      { key: "voice", value: state.voiceState + (state.activeVoiceChannelId !== null ? ` #${state.activeVoiceChannelId}` : "") },
      { key: "subs", value: String(sfuSession?.getSubscribedCount() ?? 0) },
      { key: "inbound", value: inboundAudioLine },
      { key: "sent fmtp", value: sentLine ?? "—" },
      { key: "wire fmtp", value: wireLine ?? "—" },
      { key: "user", value: state.ownUsername ?? "—" },
    ],
    stereo: reading,
    stereoVerdict: verdict,
  };
}

void shareAudioElementActive;
