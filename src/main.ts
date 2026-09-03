import { el, clear } from "./ui/dom";
import { renderLoginScreen, type LoginView } from "./ui/login";
import { renderSidebar } from "./ui/sidebar";
import { renderRoom, type RoomView } from "./ui/room";
import { DiagnosticsView } from "./ui/diagnostics";
import { Store } from "./store";
import { log } from "./logging";
import { LocalTokenStorage, type TokenStorage } from "./core/auth";
import { RestClient } from "./core/rest";
import { StompClient } from "./core/stomp";
import { JanusClient } from "./core/janus";
import { SfuSession, RoomVanishedError, type MediaSource } from "./core/sfu";
import { extractAudioFmtpLines } from "./core/sdp";
import { stereoVerdict } from "./core/audio-math";
import { RoomAudio } from "./audio";
import { renderSharePanel, type SharePanelView } from "./ui/share";
import type {
  Channel,
  FeedInfo,
  PresenceEvent,
  RemoteTrackKind,
  RoomInfo,
  UserSummary,
  VoiceMemberEvent,
  VoiceRoomState,
} from "./types";

/**
 * Renderer composition root. The protocol clients (rest/stomp/janus/sfu) plug into the
 * actions below; this file owns ONLY state + view wiring. Hot paths (speaking rings,
 * meters) update views imperatively through the 10 Hz audio poll, never via the store.
 */

interface AppState {
  screen: "login" | "main";
  ownUsername: string | null;
  baseUrl: string;
  channels: Channel[];
  users: UserSummary[];
  presence: ReadonlySet<string>;
  /** channelId → usernames in that voice channel (from /topic/voice). */
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
  activeVoiceChannelId: number | null;
  voiceState: VoiceRoomState;
  stateDetail: string | null;
  participants: FeedInfo[];
  sharing: boolean;
  testToneChannel: "left" | "right" | null;
  apmEnabled: boolean;
  viewingFeedId: number | null;
  diagOpen: boolean;
  stompState: "off" | "connecting" | "connected" | "lost";
}

const tokenStorage: TokenStorage = new LocalTokenStorage();
const roomAudio = new RoomAudio();

const store = new Store<AppState>({
  screen: "login",
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
  diagOpen: true,
  stompState: "off",
});

/** Speaking set lives OUTSIDE the store — 10 Hz churn must not rebuild views. */
const speakingUsers = new Set<string>();

const appRoot = document.querySelector<HTMLElement>("#app")!;

let loginView: LoginView | null = null;
let roomView: RoomView | null = null;
let sidebarBox: HTMLElement | null = null;
let contentBox: HTMLElement | null = null;
let diagnosticsView: DiagnosticsView | null = null;

/** Live session objects — created at login, torn down at session expiry/logout. */
let restClient: RestClient | null = null;
let stompClient: StompClient | null = null;

/** Voice session objects — created on channel join, torn down on leave. */
let janusClient: JanusClient | null = null;
let sfuSession: SfuSession | null = null;
let sharePanel: SharePanelView | null = null;
let localDisplayStream: MediaStream | null = null;
/** username of the feed whose screen we are watching (diagnostics + panel routing). */
let viewingUsername: string | null = null;
let janusSessionLostFired = false;

declare global {
  interface Window {
    spaceApp?: { version: string; platform: string };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws") + "/ws";
}

// ---------------------------------------------------------------------------
// getDisplayMedia self-test (Phase-1 risk probe): proves the main-process
// display-media handler + system-audio loopback work on THIS Electron build.
// ---------------------------------------------------------------------------
async function runDisplayMediaSelfTest(): Promise<void> {
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
    if (audioTrack) {
      log.info("selftest", "SYSTEM AUDIO TRACK PRESENT — loopback works on this build");
    } else {
      log.warn("selftest", "NO AUDIO TRACK — loopback unavailable on this build (video-only fallback)");
    }
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

async function startSession(baseUrl: string, mode: "login" | "register", username: string, password: string): Promise<void> {
  const client = new RestClient({
    baseUrl,
    tokenStorage,
    onSessionExpired: () => {
      log.warn("app", "session expired — back to login");
      teardownSession();
      store.set({ screen: "login" });
      buildShell();
      loginView?.setError("Session expired — log in again");
    },
  });
  loginView?.setBusy(true);
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
          store.set({ stompState: "lost" });
        },
        onConnected: () => {
          store.set({ stompState: "connected" });
          // Membership lives on the STOMP session — re-announce after every reconnect.
          const channelId = store.get().activeVoiceChannelId;
          if (channelId !== null) {
            stomp.send("/app/voice.join", { channelId });
          }
        },
      },
    });
    stompClient = stomp;
    store.set({ stompState: "connecting" });
    await stomp.connect();
    stomp.subscribe("/topic/presence", (raw) => applyPresenceEvent(JSON.parse(raw) as PresenceEvent));
    stomp.subscribe("/topic/voice", (raw) => applyVoiceEvent(JSON.parse(raw) as VoiceMemberEvent));

    roomAudio.setSpeakingHandler((username_, speaking) => {
      if (speaking) {
        speakingUsers.add(username_);
      } else {
        speakingUsers.delete(username_);
      }
      roomView?.setSpeaking(username_, speaking);
    });
    roomAudio.startLevelPolling();

    store.set({
      screen: "main",
      baseUrl,
      ownUsername: username,
      channels,
      users,
      presence: new Set(presence),
      voiceMembers: new Map(voiceMembers.map((entry) => [entry.channelId, new Set(entry.usernames)])),
    });
    buildShell();
    await roomAudio.resume();
    log.info("app", `session up: ${username} @ ${baseUrl} (${channels.length} channels, ${users.length} users)`);
  } catch (error) {
    loginView?.setError(errorMessage(error));
  } finally {
    loginView?.setBusy(false);
  }
}

function teardownSession(): void {
  void teardownVoice();
  roomAudio.stopLevelPolling();
  roomAudio.detachOwnMic();
  speakingUsers.clear();
  stompClient?.disconnect();
  stompClient = null;
  restClient = null;
  store.set({
    stompState: "off",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    participants: [],
    sharing: false,
    viewingFeedId: null,
  });
}

// ---------------------------------------------------------------------------
// Voice session (room → Janus → SFU)
// ---------------------------------------------------------------------------

async function joinVoice(channel: Channel): Promise<void> {
  if (!restClient) {
    return;
  }
  await teardownVoice();
  store.set({ activeVoiceChannelId: channel.id, voiceState: "connecting", stateDetail: null, participants: [], viewingFeedId: null });

  let room: RoomInfo;
  try {
    room = await restClient.getRoom(channel.id);
  } catch (error) {
    store.set({ voiceState: "failed", stateDetail: errorMessage(error) });
    return;
  }
  stompClient?.send("/app/voice.join", { channelId: channel.id });

  janusSessionLostFired = false;
  const janus = new JanusClient({
    baseUrl: room.janusUrl,
    token: room.token,
    pin: room.pin,
    roomId: room.roomId,
    onEvent: (handleId, event) => sfuSession?.handleEvent(event),
    onJsep: (handleId, jsep) => {
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
      store.set({ voiceState: "reconnecting", stateDetail: reason });
      // Phase 9 adds the 1/2/4/8s rejoin ladder; for now the user can re-click the channel.
    },
  });
  janusClient = janus;

  try {
    // open() = create session + attach the publisher handle + start the poll loop;
    // events arriving before sfuSession is assigned are dropped by design —
    // publishers only appear after OUR join, which start() sends below.
    const publisherHandleId = await janus.open();
    const session = new SfuSession({
      room,
      username: store.get().ownUsername ?? "user",
      janus,
      publisherHandleId,
      mediaSource: navigator.mediaDevices as MediaSource,
      callbacks: {
        onParticipants: (feeds) => store.set({ participants: feeds }),
        onRemoteTrack: handleRemoteTrack,
        onRemoteTrackEnded: handleRemoteTrackEnded,
        onState: (state, detail) => store.set({ voiceState: state, stateDetail: detail ?? null }),
        onError: (error) => {
          if (error instanceof RoomVanishedError) {
            store.set({ voiceState: "failed", stateDetail: "room vanished — re-click the channel" });
          } else {
            log.error("voice", `sfu: ${error.message}`);
            store.set({ stateDetail: error.message });
          }
        },
      },
    });
    sfuSession = session;
    await session.start();
    const mic = session.getMicTrack();
    if (mic) {
      roomAudio.attachOwnMic(store.get().ownUsername ?? "you", mic);
    }
    log.info("voice", `joined room ${room.roomId} on ${room.janusUrl}`);
  } catch (error) {
    store.set({ voiceState: "failed", stateDetail: errorMessage(error) });
    await teardownVoice();
    stompClient?.send("/app/voice.leave", { channelId: channel.id });
  }
}

async function teardownVoice(): Promise<void> {
  if (sharePanel) {
    sharePanel = null;
    if (contentBox) {
      contentBox.querySelectorAll(".share-panel").forEach((node) => node.remove());
    }
  }
  viewingUsername = null;
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
}

/** Restored per-user gain after (re)attach — sliders persist across sessions. */
function persistedGain(kind: "voice" | "share", username: string): number {
  return Number(localStorage.getItem(`space.vol.${kind}.${username}`) ?? 100) / 100;
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
  // video: only render while we are watching THIS feed
  if (store.get().viewingFeedId === feedId && contentBox) {
    viewingUsername = username;
    if (!sharePanel) {
      sharePanel = renderSharePanel(contentBox, username, {
        setShareVolume: (owner, gain) => roomAudio.setShareVolume(owner, gain),
        stopWatching: () => store.set({ viewingFeedId: null }),
      });
    }
    sharePanel.setTitle(username);
    sharePanel.attachVideo(track);
  }
}

function handleRemoteTrackEnded(feedId: number, username: string, kind: RemoteTrackKind): void {
  if (kind === "video") {
    if (sharePanel) {
      sharePanel = null;
      contentBox?.querySelectorAll(".share-panel").forEach((node) => node.remove());
    }
    viewingUsername = null;
    return;
  }
  roomAudio.detachFeed(feedId);
}

async function toggleShare(): Promise<void> {
  if (!sfuSession) {
    return;
  }
  if (store.get().sharing) {
    await sfuSession.stopShare().catch(() => undefined);
    if (localDisplayStream) {
      for (const track of localDisplayStream.getTracks()) {
        track.stop();
      }
      localDisplayStream = null;
    }
    store.set({ sharing: false });
    return;
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: { ideal: 2 } },
    });
    localDisplayStream = display;
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void toggleShare(); // user stopped sharing via the browser chrome
    });
    await sfuSession.startShare(display);
    const shareAudio = display.getAudioTracks()[0];
    log.info("share", `publishing share (audio channels=${shareAudio ? shareAudio.getSettings().channelCount ?? "?" : "none"})`);
    store.set({ sharing: true });
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

function applyPresenceEvent(event: PresenceEvent): void {
  const presence = new Set(store.get().presence);
  if (event.status === "ONLINE") {
    presence.add(event.username);
  } else {
    presence.delete(event.username);
  }
  store.set({ presence });
}

function applyVoiceEvent(event: VoiceMemberEvent): void {
  const voiceMembers = new Map(store.get().voiceMembers);
  const current = new Set(voiceMembers.get(event.channelId) ?? []);
  if (event.status === "JOINED") {
    current.add(event.username);
  } else {
    current.delete(event.username);
  }
  voiceMembers.set(event.channelId, current);
  store.set({ voiceMembers });
  log.info("voice", `${event.username} ${event.status.toLowerCase()} channel #${event.channelId}`);
}

// ---------------------------------------------------------------------------
// View wiring
// ---------------------------------------------------------------------------

function buildShell(): void {
  clear(appRoot);
  document.body.classList.toggle("diag-open", store.get().diagOpen);

  if (store.get().screen === "login") {
    roomView = null;
    sidebarBox = null;
    contentBox = null;
    loginView = renderLoginScreen(appRoot, {
      login(baseUrl: string, username: string, password: string): void {
        void startSession(baseUrl, "login", username, password);
      },
      register(baseUrl: string, username: string, password: string): void {
        void startSession(baseUrl, "register", username, password);
      },
    });
    return;
  }

  loginView = null;
  const shell = el("div", { class: "main-shell" });
  sidebarBox = el("aside", { class: "sidebar" });
  contentBox = el("main", { class: "content" });
  shell.append(sidebarBox, contentBox);
  appRoot.append(shell);

  roomView = renderRoom(contentBox, roomStateFromStore(), {
    leave(): void {
      const channelId = store.get().activeVoiceChannelId;
      void teardownVoice();
      if (channelId !== null) {
        stompClient?.send("/app/voice.leave", { channelId });
      }
      store.set({ activeVoiceChannelId: null, voiceState: "idle", participants: [], viewingFeedId: null });
    },
    toggleShare(): void {
      void toggleShare();
    },
    toggleTestTone(channel: "left" | "right"): void {
      if (roomAudio.getTestToneChannel() === channel) {
        roomAudio.stopStereoTestTone();
      } else {
        roomAudio.startStereoTestTone(channel);
      }
      store.set({ testToneChannel: roomAudio.getTestToneChannel() });
    },
    setVoiceVolume(username: string, gain: number): void {
      roomAudio.setVoiceVolume(username, gain);
    },
    setShareVolume(username: string, gain: number): void {
      roomAudio.setShareVolume(username, gain);
    },
    toggleApm(): void {
      store.set({ apmEnabled: !store.get().apmEnabled });
      log.info("app", `APM toggle (mic re-acquire lands in phase 9): ${store.get().apmEnabled}`);
    },
    toggleViewing(feedId: number): void {
      const next = store.get().viewingFeedId === feedId ? null : feedId;
      store.set({ viewingFeedId: next });
      sfuSession?.setViewingFeed(next);
      if (next === null) {
        sharePanel = null;
        contentBox?.querySelectorAll(".share-panel").forEach((node) => node.remove());
        viewingUsername = null;
      }
    },
  });
}

function roomStateFromStore() {
  const state = store.get();
  return {
    ownUsername: state.ownUsername ?? "you",
    voiceState: state.voiceState,
    stateDetail: state.stateDetail,
    participants: state.participants,
    speaking: speakingUsers,
    sharing: state.sharing,
    testToneChannel: state.testToneChannel,
    apmEnabled: state.apmEnabled,
    viewingFeedId: state.viewingFeedId,
  };
}

function renderCurrent(): void {
  const state = store.get();
  document.body.classList.toggle("diag-open", state.diagOpen);
  if (state.screen === "main" && sidebarBox) {
    renderSidebar(sidebarBox, {
      channels: state.channels,
      users: state.users,
      presence: state.presence,
      voiceMembers: state.voiceMembers,
      activeVoiceChannelId: state.activeVoiceChannelId,
    }, {
      joinVoiceChannel(channel: Channel): void {
        if (channel.id === state.activeVoiceChannelId) {
          return;
        }
        if (state.activeVoiceChannelId !== null) {
          stompClient?.send("/app/voice.leave", { channelId: state.activeVoiceChannelId });
        }
        void joinVoice(channel);
      },
    });
  }
  roomView?.rebuild(roomStateFromStore());
}

store.subscribe(renderCurrent);
buildShell();

// Diagnostics panel + its 4 Hz refresh tick (meters + connection readout).
diagnosticsView = new DiagnosticsView(document.body, {
  runDisplayMediaSelfTest(): void {
    void runDisplayMediaSelfTest();
  },
});

/** Refreshed once a second by the async stats poll below; read by the 4 Hz diag tick. */
let inboundAudioLine = "—";
let lastLoggedVerdict: string | null = null;

/** " (signal LEFT/RIGHT)" for verdict lines — catches channel swaps on sequential L/R tests. */
function dominantChannel(reading: { leftDbfs: number; rightDbfs: number } | null): string {
  if (!reading) {
    return "";
  }
  if (reading.leftDbfs - reading.rightDbfs > 6) {
    return " (signal LEFT)";
  }
  if (reading.rightDbfs - reading.leftDbfs > 6) {
    return " (signal RIGHT)";
  }
  return "";
}
window.setInterval(() => {
  void sfuSession?.getInboundAudioLine().then((line) => {
    inboundAudioLine = line;
  });
}, 1_000);

const diagToggleButton = el("button", { class: "diag-toggle" }, "diag");
diagToggleButton.addEventListener("click", () => {
  store.set({ diagOpen: !store.get().diagOpen });
});
document.body.append(diagToggleButton);

function updateMeters(): void {
  for (const username of store.get().voiceMembers.get(store.get().activeVoiceChannelId ?? -1) ?? []) {
    const voiceMeter = document.querySelector<HTMLElement>(`[data-meter-voice="${username}"]`);
    const voiceDbfs = roomAudio.getVoiceLevelDbfs(username);
    if (voiceMeter) {
      voiceMeter.textContent = voiceDbfs === null ? "—" : (voiceDbfs <= -100 ? "−∞" : voiceDbfs.toFixed(0)) + " dB";
    }
    const shareMeter = document.querySelector<HTMLElement>(`[data-meter-share="${username}"]`);
    const shareDbfs = roomAudio.getShareLevelDbfs(username);
    if (shareMeter) {
      shareMeter.textContent = shareDbfs === null ? "—" : (shareDbfs <= -100 ? "−∞" : shareDbfs.toFixed(0)) + " dB";
    }
  }
}

window.setInterval(() => {
  const state = store.get();
  updateMeters();

  // Stereo oracle, three layers: sent fmtp / wire fmtp / acoustic reading.
  const sentFmtp = sfuSession?.getPublisherLocalSdp();
  const sentLine = sentFmtp ? extractAudioFmtpLines(sentFmtp).map((line) => `m${line.mindex}${line.mid ? `(${line.mid})` : ""}: ${line.fmtp ?? "—"}`).join(" | ") : null;
  const wireFmtp = sfuSession?.getLastSubscriberOfferSdp();
  const wireLine = wireFmtp ? extractAudioFmtpLines(wireFmtp).map((line) => `m${line.mindex}: ${line.fmtp ?? "—"}`).join(" | ") : null;

  const probeTarget = viewingUsername ?? state.participants.find((feed) => store.get().viewingFeedId === feed.feedId)?.display ?? null;
  const reading = probeTarget ? roomAudio.stereoProbe(probeTarget) : null;
  const verdict = reading ? stereoVerdict(reading) : null;
  if (verdict !== null && verdict !== lastLoggedVerdict) {
    lastLoggedVerdict = verdict;
    log.info("oracle",
      `verdict ${verdict}${dominantChannel(reading)}: L=${reading?.leftDbfs.toFixed(1)} dB R=${reading?.rightDbfs.toFixed(1)} dB`
      + ` Δ=${reading?.deltaDb.toFixed(1)} dB ch=${reading?.channelCount} (target "${probeTarget}")`);
  }

  diagnosticsView?.update({
    lines: [
      { key: "version", value: window.spaceApp?.version ?? "?" },
      { key: "platform", value: window.spaceApp?.platform ?? "?" },
      { key: "screen", value: state.screen },
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
  });
}, 250);

log.info("app", `space renderer up (version ${window.spaceApp?.version ?? "?"})`);
