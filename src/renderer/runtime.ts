import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { MemoryTokenStorage } from "../core/auth";
import { RestClient } from "../core/rest";
import { JanusClient } from "../core/janus";
import { SfuSession, RoomVanishedError, type MediaSource } from "../core/sfu";
import { extractAudioFmtpLines } from "../core/sdp";
import { stereoVerdict } from "../core/audio-math";
import { RoomAudio } from "../media/RoomAudio";
import {
  ConnectionDirectory,
  EXPIRED_MARKER,
  normalizeHostUrl,
  RecordTokenStorage,
} from "../domain/session/connection-record";
import { ConnectionSession, type SessionHooks } from "../domain/session/connection-session";
import { notifications } from "./notifications";
import { virtualScrollTelemetry } from "./scroll-telemetry";
import type {
  Channel,
  FeedInfo,
  Message,
  RemoteTrackKind,
  RoomInfo,
  VoiceRoomState,
} from "../types";

/**
 * The application runtime — a MODULE SINGLETON, deliberately outside the React tree:
 * Fast Refresh only reloads components, so editing UI code never tears down WebRTC,
 * STOMP sessions or the audio graph. M1 splits the per-connection world into
 * ConnectionSession (domain); what remains here is the app shell: the connection
 * directory, the ONE active session binding, and the voice room plumbing.
 */

export interface AppState {
  screen: "login" | "main";
  loginError: string | null;
  loginBusy: boolean;
  loginPrefill: { url: string; username: string } | null;
  ownUsername: string | null;
  baseUrl: string;
  /** Active TEXT channel (the chat pane); null = nothing selected yet. */
  activeChannelId: number | null;
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
    loginPrefill: null,
    ownUsername: null,
    baseUrl: "",
    activeChannelId: null,
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
export const connectionDirectory = new ConnectionDirectory();

/** The single active session (v1). Login flow and the rail re-point it. */
let activeSession: ConnectionSession | null = null;

class SessionBinding extends Emitter {
  getSnapshot = (): ConnectionSession | null => activeSession;

  set(next: ConnectionSession | null): void {
    activeSession = next;
    this.emit();
  }
}

export const sessionBinding = new SessionBinding();

/** Live voice-session objects — owned here, not per ConnectionSession (M4 moves them). */
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
// Session lifecycle: bootstrap → login/resume → open → teardown
// ---------------------------------------------------------------------------

const sessionHooks: SessionHooks = {
  onSessionExpired: (recordId) => {
    log.warn("app", `session expired (record ${recordId}) — back to login`);
    void teardownSession();
    appStore.patch({ screen: "login", loginError: "Session expired — log in again" });
  },
  onStompState: (state) => appStore.patch({ stompState: state }),
  onStompConnected: () => {
    const channelId = appStore.getSnapshot().activeVoiceChannelId;
    if (channelId !== null) {
      activeSession?.stomp.send("/app/voice.join", { channelId });
    }
  },
  onChannelGone: (channelId) => {
    if (appStore.getSnapshot().activeChannelId === channelId) {
      pickFallbackTextChannel();
    }
    if (appStore.getSnapshot().activeVoiceChannelId === channelId) {
      void leaveVoice();
    }
  },
  onChannelsChanged: () => {
    ensureActiveChannelExists();
  },
  onLiveMessage: (message) => {
    const session = activeSession;
    const state = appStore.getSnapshot();
    if (!session || state.ownUsername === null) {
      return;
    }
    const inOpenChannel = state.activeChannelId === message.channelId;
    const windowFocused = document.hasFocus();
    session.readStateStore.bumpLive(message, state.ownUsername, inOpenChannel, windowFocused);
    if (inOpenChannel && windowFocused) {
      return;
    }
    const channel = session.channelStore.get(message.channelId);
    notifications.handleMessage(
      message,
      state.ownUsername,
      channel ? `#${channel.name}` : `#${message.channelId}`,
      windowFocused,
      inOpenChannel,
    );
  },
};

/** App entry: load the directory, auto-resume the most recently used connection. */
export async function bootstrapApp(): Promise<void> {
  await connectionDirectory.loadAll();
  const newest = connectionDirectory.getSnapshot()[0];
  if (newest && newest.refreshToken !== "" && newest.token !== EXPIRED_MARKER) {
    try {
      await openSession(newest.id);
      log.info("app", `auto-resumed ${newest.username} @ ${newest.hostUrl}`);
    } catch (error) {
      log.info("app", `auto-resume failed (${errorMessage(error)}) — login screen`);
    }
  }
}

export async function startSession(baseUrl: string, mode: "login" | "register", username: string, password: string): Promise<void> {
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
      await loginClient.register(username, password);
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

/** Rail click on another record: switch (resume) or re-login when the family is dead. */
export async function switchConnection(recordId: string): Promise<void> {
  if (appStore.getSnapshot().loginBusy) {
    return;
  }
  const record = connectionDirectory.get(recordId);
  if (!record || activeSession?.recordId === recordId) {
    return;
  }
  appStore.patch({ loginBusy: true, loginError: null });
  try {
    await openSession(recordId);
  } catch (error) {
    appStore.patch({
      screen: "login",
      loginError: errorMessage(error),
      loginPrefill: { url: record.hostUrl, username: record.username },
    });
  } finally {
    appStore.patch({ loginBusy: false });
  }
}

export async function removeConnection(recordId: string): Promise<void> {
  if (activeSession?.recordId === recordId) {
    await teardownSession();
    appStore.patch({ screen: "login" });
  }
  await connectionDirectory.remove(recordId);
}

/** "+" on the rail: login screen with an empty form (the live session stays alive). */
export function beginAddServer(): void {
  appStore.patch({ screen: "login", loginError: null, loginPrefill: null });
}

async function openSession(recordId: string): Promise<void> {
  await teardownSession();
  const record = connectionDirectory.get(recordId);
  if (!record) {
    return;
  }
  const session = new ConnectionSession({ directory: connectionDirectory, recordId, hooks: sessionHooks });
  activeSession = session;
  sessionBinding.set(session);
  try {
    await session.start();
    appStore.patch({
      screen: "main",
      loginError: null,
      loginPrefill: null,
      ownUsername: record.username,
      baseUrl: record.hostUrl,
    });
    restoreLastChannel(session);
    roomAudio.setSpeakingHandler((username, speaking) => {
      voiceView.onSpeaking(username, speaking);
    });
    roomAudio.startLevelPolling();
    await roomAudio.resume();
  } catch (error) {
    await teardownSession();
    throw error;
  }
}

export async function teardownSession(): Promise<void> {
  await teardownVoice();
  roomAudio.stopLevelPolling();
  roomAudio.detachOwnMic();
  activeSession?.dispose();
  activeSession = null;
  sessionBinding.set(null);
  appStore.patch({
    stompState: "off",
    screen: "login",
    ownUsername: null,
    activeChannelId: null,
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    participants: [],
    sharing: false,
    viewingFeedId: null,
    viewingUsername: null,
  });
}

// ---------------------------------------------------------------------------
// Active text channel (lastChannel persistence)
// ---------------------------------------------------------------------------

export function setActiveChannel(channelId: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  appStore.patch({ activeChannelId: channelId });
  void session.loadHistory(channelId)
    .then(() => ackActiveChannel())
    .catch((error: unknown) => {
      log.warn("chat", `history load failed: ${errorMessage(error)}`);
    });
  void connectionDirectory.update(session.recordId, { lastChannelId: channelId });
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
    };
  });
  session.messageStore.applySnapshot(channelId, synthetic);
  log.info("perf", `seeded ${count} synthetic messages into channel #${channelId} — scroll it`);
}

/** Ack the open channel up to its newest loaded message (divider dismisses with it). */
export function ackActiveChannel(): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeChannelId;
  if (!session || channelId === null) {
    return;
  }
  const messages = session.messageStore.listFor(channelId);
  const lastId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const state = session.readStateStore.get(channelId);
  if (lastId === null && state.unreadCount === 0) {
    return;
  }
  if (lastId !== null && state.lastReadMessageId === lastId && state.unreadCount === 0) {
    return;
  }
  session.ackChannelRead(channelId, lastId);
}

/** Cross-instance forward: a THROWAWAY client for the target record (v1: one active session). */
export async function forwardCrossInstance(targetRecordId: string, targetChannelId: number, snapshot: {
  content: string | null;
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
    originServer: snapshot.originServer,
    originChannel: snapshot.originChannel,
    originAuthorId: snapshot.originAuthorId,
    originAuthorName: snapshot.originAuthorName,
    originCreatedAt: snapshot.originCreatedAt,
    originReply: snapshot.originReply,
  });
}

function restoreLastChannel(session: ConnectionSession): void {
  const record = connectionDirectory.get(session.recordId);
  const textChannels = session.channelStore.getSnapshot().filter((channel) => channel.type === "TEXT");
  const preferred = record?.lastChannelId != null
    ? textChannels.find((channel) => channel.id === record.lastChannelId)
    : undefined;
  const chosen = preferred ?? textChannels[0] ?? null;
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
  const stillThere = current !== null && session.channelStore.get(current) !== null;
  if (!stillThere) {
    pickFallbackTextChannel();
  }
}

function pickFallbackTextChannel(): void {
  const session = activeSession;
  if (!session) {
    appStore.patch({ activeChannelId: null });
    return;
  }
  const fallback = session.channelStore.getSnapshot().find((channel) => channel.type === "TEXT") ?? null;
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
export async function joinVoice(channel: Channel): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  await teardownVoice();
  appStore.patch({ activeVoiceChannelId: channel.id, voiceState: "connecting", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null });

  let room: RoomInfo;
  try {
    room = await session.rest.getRoom(channel.id);
  } catch (error) {
    appStore.patch({ voiceState: "failed", stateDetail: errorMessage(error) });
    return;
  }
  session.stomp.send("/app/voice.join", { channelId: channel.id });

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
    const sfu = new SfuSession({
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
    sfuSession = sfu;
    await sfu.start();
    const mic = sfu.getMicTrack();
    if (mic) {
      roomAudio.attachOwnMic(appStore.getSnapshot().ownUsername ?? "you", mic);
    }
    log.info("voice", `joined room ${room.roomId} on ${room.janusUrl}`);
  } catch (error) {
    appStore.patch({ voiceState: "failed", stateDetail: errorMessage(error) });
    await teardownVoice();
    activeSession?.stomp.send("/app/voice.leave", { channelId: channel.id });
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
    activeSession?.stomp.send("/app/voice.leave", { channelId });
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
}

export function setShareVolume(username: string, gain: number): void {
  roomAudio.setShareVolume(username, gain);
  if (activeSession) {
    connectionDirectory.setVolume(activeSession.recordId, "share", username, gain);
  }
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
      { key: "vscroll", value: `${Math.round(virtualScrollTelemetry.scrollTop)}/${Math.round(virtualScrollTelemetry.scrollHeight)} (${(virtualScrollTelemetry.thumbFraction * 100).toFixed(0)}%)` },
    ],
    stereo: reading,
    stereoVerdict: verdict,
  };
}

void shareAudioElementActive;
