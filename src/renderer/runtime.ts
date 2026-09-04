import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { MemoryTokenStorage } from "../core/auth";
import { RestClient } from "../core/rest";
import { JanusClient } from "../core/janus";
import { SfuSession, RoomVanishedError, SubscriberTransportError, type MediaSource } from "../core/sfu";
import { PeerCallSession, type PeerCallOptions, type PeerTrackKind } from "../core/peer-call";
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
import { MAX_VOICE_REJOIN_ATTEMPTS, rejoinDelayMs, rejoinExhausted } from "../domain/logic/rejoin-ladder";
import { dmDisplayName } from "../domain/logic/dm-display";
import { notifications } from "./notifications";
import { virtualScrollTelemetry } from "./scroll-telemetry";
import type {
  CallConfig,
  Channel,
  FeedInfo,
  IncomingCallSignal,
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
  screen: "login" | "main";
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
  peerMicOn: boolean;
  peerDeafenedOn: boolean;
  peerCameraOn: boolean;
  peerScreenOn: boolean;
  /** The room↔call exclusivity question awaiting the user's answer. */
  callConflict: { kind: "start-call" | "accept-call" | "join-voice"; peer: string | null; voiceChannelId: number | null } | null;
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
    dmMode: false,
    activeDmId: null,
    friendsTab: "ALL",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
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
    peerMicOn: true,
    peerDeafenedOn: false,
    peerCameraOn: false,
    peerScreenOn: false,
    callConflict: null,
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
let localCameraStream: MediaStream | null = null;
let janusSessionLostFired = false;
let shareAudioElementActive = false;

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
    const dm = session.socialStore.getDm(message.channelId);
    const channel = dm === null ? session.channelStore.get(message.channelId) : null;
    if (dm === null && channel === null) {
      return; // a channel we closed/left — a frame still in flight after the unsubscribe
    }
    const inOpenChannel = (dm !== null
      ? state.dmMode && state.activeDmId === message.channelId
      : state.activeChannelId === message.channelId);
    const windowFocused = document.hasFocus();
    // DM rule: EVERY direct message is a mention equivalent (oak parity) — the
    // badge is red and the bell rings even without an @.
    session.readStateStore.bumpLive(message, state.ownUsername, inOpenChannel, windowFocused, dm !== null);
    if (dm !== null) {
      session.socialStore.updateDmLastMessage(message); // float the row + refresh the preview
    }
    if (inOpenChannel && windowFocused) {
      return;
    }
    const channelName = dm !== null
      ? dmDisplayName(dm, state.ownUsername)
      : channel !== null ? `#${channel.name}` : `#${message.channelId}`;
    notifications.handleMessage(
      message,
      state.ownUsername,
      channelName,
      windowFocused,
      inOpenChannel,
      dm !== null,
      dm !== null ? () => openDm(dm.id) : undefined,
    );
  },
  onOwnVoiceControlState: (state) => {
    // The union drives our mic and our speakers; ONLY a moderator mute cuts the
    // share audio too (a self-mute must leave the music playing — Discord semantics).
    voiceCompliance.micMuted = state.muted;
    voiceCompliance.shareAudioMuted = state.modMuted;
    voiceCompliance.deafened = state.deafened;
    applyComplianceToLiveSession();
    log.info("voice", `compliance: mic=${state.muted ? "muted" : "open"} (self=${state.selfMuted} mod=${state.modMuted})`
      + ` deafened=${state.deafened} shareAudio=${state.modMuted ? "muted" : "open"}`);
  },
  onVoiceKicked: (byUsername) => {
    cancelVoiceRejoin();
    void leaveVoice();
    notifications.showToast({ title: "Voice", channelName: byUsername, body: "You were kicked from the voice channel." });
  },
  onCallSignal: (signal) => handleCallSignal(signal),
  onDmClosed: (channelId) => {
    if (appStore.getSnapshot().activeDmId === channelId) {
      appStore.patch({ activeDmId: null }); // back to the Friends pane
    }
  },
  onMemberKicked: (event) => {
    // Tokens survive a kick (only a BAN kills them at the REST layer) — dropping
    // to the login screen keeps the record one click away, oak's ErrorDialog parity.
    const reason = event.banned
      ? `You were banned by ${event.by}. A moderator must unban you before reconnecting.`
      : `You were removed from the server by ${event.by}. Click the server again to reconnect.`;
    void teardownSession().finally(() => {
      appStore.patch({ loginError: reason });
      notifications.showToast({ title: event.banned ? "Banned" : "Removed from server", channelName: event.by, body: reason });
    });
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
  teardownCall();
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
    dmMode: false,
    activeDmId: null,
    friendsTab: "ALL",
    activeVoiceChannelId: null,
    voiceState: "idle",
    stateDetail: null,
    participants: [],
    sharing: false,
    cameraOn: false,
    popoutActive: false,
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
  appStore.patch({ activeChannelId: channelId, dmMode: false, activeDmId: null });
  void session.loadHistory(channelId)
    .then(() => ackActiveChannel())
    .catch((error: unknown) => {
      log.warn("chat", `history load failed: ${errorMessage(error)}`);
    });
  void connectionDirectory.update(session.recordId, { lastChannelId: channelId });
}

// ---------------------------------------------------------------------------
// Home mode (friends + DMs)
// ---------------------------------------------------------------------------

/** The Home button: toggle between the server view and the DM/friends view. */
export function toggleHomeMode(): void {
  const next = !appStore.getSnapshot().dmMode;
  appStore.patch({ dmMode: next, activeDmId: next ? appStore.getSnapshot().activeDmId : null });
}

/** Clicking the ACTIVE server icon while in Home = go back to the server view. */
export function exitHomeMode(): void {
  if (appStore.getSnapshot().dmMode) {
    appStore.patch({ dmMode: false, activeDmId: null });
  }
}

export function setFriendsTab(tab: FriendsTab): void {
  appStore.patch({ dmMode: true, activeDmId: null, friendsTab: tab });
}

/** Open one DM chat (the row click / the toast click / the friends "Message" button). */
export function openDm(channelId: number): void {
  const session = activeSession;
  if (!session) {
    return;
  }
  appStore.patch({ dmMode: true, activeDmId: channelId });
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
  attachments?: { key: string; fileName: string }[] | null;
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

/** Rejoin ladder state (oak parity: 5 attempts, delays 1/2/4/8/8 s). */
let voiceRejoin: { channelId: number; attempt: number; timer: number } | null = null;

function cancelVoiceRejoin(): void {
  if (voiceRejoin !== null) {
    window.clearTimeout(voiceRejoin.timer);
    voiceRejoin = null;
  }
}

export async function joinVoice(channel: Channel): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  cancelVoiceRejoin();
  await teardownVoice();
  // Entering a room is a fresh voice state: self-marks are dropped server-side on
  // leave, and a surviving moderator mark re-publishes via /topic/voice.state.
  session.voiceControlStore.clearAll();
  voiceCompliance.micMuted = false;
  voiceCompliance.shareAudioMuted = false;
  voiceCompliance.deafened = false;
  roomAudio.setDeafened(false);
  appStore.patch({ activeVoiceChannelId: channel.id, voiceState: "connecting", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null });
  session.stomp.send("/app/voice.join", { channelId: channel.id });

  try {
    await connectVoiceRoom(channel);
    notifications.playKnock("join");
  } catch (error) {
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
          onParticipants: (feeds) => appStore.patch({ participants: feeds }),
          onRemoteTrack: handleRemoteTrack,
          onRemoteTrackEnded: handleRemoteTrackEnded,
          onState: (state, detail) => appStore.patch({ voiceState: state, stateDetail: detail ?? null }),
          onError: (error) => {
            if (error instanceof RoomVanishedError) {
              // The room died under a LIVE session — the rejoin ladder owns it now.
              handleVoiceSessionLost("room vanished (426)");
            } else if (error instanceof SubscriberTransportError) {
              // Incoming media died silently (ICE failure on the subscriber PC) — the
              // ladder rebuilds the session, exactly the manual re-click that cured it.
              handleVoiceSessionLost("incoming media transport failed");
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
  appStore.patch({ voiceState: "reconnecting", stateDetail: `reconnecting ${attempt}/${MAX_VOICE_REJOIN_ATTEMPTS} — ${reason}` });
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
        appStore.patch({ stateDetail: "reconnected — waiting for media" });
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
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null });
  if (hadSession) {
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

export async function teardownVoice(): Promise<void> {
  voiceView.dropShareVideo();
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
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null });
  if (hadSession) {
    notifications.playKnock("leave");
  }
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

/** A share source picked in the picker modal (M4): screen, window or camera. */
export interface ShareTarget {
  kind: "screen" | "window" | "camera";
  /** desktopCapturer source id, or the camera deviceId for kind="camera". */
  id: string;
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

async function stopShareInternal(): Promise<void> {
  if (sfuSession) {
    await sfuSession.stopShare().catch(() => undefined);
  }
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
        video: { deviceId: { exact: target.id }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      localCameraStream = cameraStream;
      await sfuSession.startCamera(cameraStream);
      appStore.patch({ cameraOn: true });
      log.info("camera", `camera publishing (device ${target.id})`);
      return;
    }
    if (appStore.getSnapshot().cameraOn) {
      await stopCameraLocal();
    }
    if (appStore.getSnapshot().sharing) {
      await stopShareInternal();
    }
    // Tell main which source the NEXT getDisplayMedia grant should hand out; loopback
    // system audio only exists for whole screens (windows and cameras never carry it).
    await window.spaceCapture?.select(target.id, target.kind === "screen");
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: target.kind === "screen" ? { channelCount: { ideal: 2 } } : false,
    });
    localDisplayStream = display;
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void stopShareInternal();
    });
    await sfuSession.startShare(display);
    const shareAudio = display.getAudioTracks()[0];
    log.info("share", `publishing ${target.kind} "${target.id}" (audio channels=${shareAudio ? shareAudio.getSettings().channelCount ?? "?" : "none"})`);
    appStore.patch({ sharing: true });
  } catch (error) {
    log.error("share", `share failed: ${errorMessage(error)}`);
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

/** The camera toggle button — the default device, no picker. */
export async function toggleCamera(): Promise<void> {
  if (!sfuSession) {
    return;
  }
  if (appStore.getSnapshot().cameraOn) {
    await stopCameraLocal();
    return;
  }
  try {
    if (appStore.getSnapshot().sharing) {
      await stopShareInternal();
    }
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    localCameraStream = cameraStream;
    await sfuSession.startCamera(cameraStream);
    appStore.patch({ cameraOn: true });
    log.info("camera", "camera publishing (default device)");
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

export function stopShare(): Promise<void> {
  return stopShareInternal();
}

// ---------------------------------------------------------------------------
// Voice control commands (self toggles + moderation)
// ---------------------------------------------------------------------------

/** Self-mute: the toggle reads ONLY the self flag — a moderator's mute is not ours to lift. */
export function toggleSelfMute(): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(session.username());
  session.sendVoiceControl("/app/voice.mute", channelId, session.username(), { muted: !marks.selfMuted });
}

export function toggleSelfDeafen(): void {
  const session = activeSession;
  const channelId = appStore.getSnapshot().activeVoiceChannelId;
  if (!session || channelId === null) {
    return;
  }
  const marks = session.voiceControlStore.marksFor(session.username());
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
// Share pop-out window
// ---------------------------------------------------------------------------

export async function openSharePopout(): Promise<void> {
  const opened = (await window.spaceWindow?.openPopout()) ?? false;
  if (opened) {
    appStore.patch({ popoutActive: true });
  }
}

export function popoutClosed(): void {
  appStore.patch({ popoutActive: false });
}

/** A JPEG frame from the share <video> — relayed to the pop-out window. */
export function sendPopoutFrame(dataUrl: string): void {
  window.spaceWindow?.sendFrame(dataUrl);
}

// ---------------------------------------------------------------------------
// 1:1 P2P calls (M5) — RING/ACCEPT handshake, PeerCallSession, sounds, exclusivity
// ---------------------------------------------------------------------------

const CALL_VOICE_FEED_ID = -1;
const CALL_SHARE_FEED_ID = -2;
const RING_TIMEOUT_MS = 60_000;
const CALL_GAP_TIMEOUT_MS = 30_000;

let callSession: PeerCallSession | null = null;
let callMicStream: MediaStream | null = null;
let callCameraStream: MediaStream | null = null;
let callDisplayStream: MediaStream | null = null;
let ringTimeoutTimer: number | null = null;
let gapTimeoutTimer: number | null = null;
let callTickerTimer: number | null = null;
/** The mic state to restore when a self-deafen ends (oak's implied-mute survival). */
let callMicStateBeforeDeafen = true;
/** Signals that raced ahead of the session (OFFER while the callee's mic was still starting). */
const pendingCallSignals: IncomingCallSignal[] = [];

/** Wiring point for the call pane's imperative peer-video view. */
export const callView = {
  attachPeerVideo(_track: MediaStreamTrack): void {
    // replaced by CallPane at mount
  },
  dropPeerVideo(): void {
    // replaced by CallPane at mount
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
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
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
      clearGapTimeout();
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
      if (state.callState !== "idle") {
        // Busy — the polite auto-reject (oak parity: a duplicate RING never reaches the card).
        activeSession?.sendCallSignal({ type: "REJECT", to: signal.from, sdp: null, candidate: null });
        return;
      }
      appStore.patch({ callState: "ringing-in", callPeer: signal.from, callHealthy: true, callSeconds: 0 });
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

function armRingTimeout(): void {
  clearRingTimeout();
  ringTimeoutTimer = window.setTimeout(() => {
    const state = appStore.getSnapshot();
    if (state.callState === "ringing-out") {
      activeSession?.sendCallSignal({ type: "HANGUP", to: state.callPeer ?? "", sdp: null, candidate: null });
      teardownCall();
      notifications.showToast({ title: "Call", channelName: state.callPeer ?? "", body: "No answer." });
    } else if (state.callState === "ringing-in") {
      teardownCall(); // missed call — the caller's own timeout sends HANGUP
    }
  }, RING_TIMEOUT_MS);
}

function clearRingTimeout(): void {
  if (ringTimeoutTimer !== null) {
    window.clearTimeout(ringTimeoutTimer);
    ringTimeoutTimer = null;
  }
}

/** accept→media window: if the peer vanished after ACCEPT, do not hang in "connecting". */
function armGapTimeout(): void {
  clearGapTimeout();
  gapTimeoutTimer = window.setTimeout(() => {
    if (appStore.getSnapshot().callState === "connecting") {
      teardownCall();
      notifications.showToast({ title: "Call", channelName: appStore.getSnapshot().callPeer ?? "", body: "Could not connect." });
    }
  }, CALL_GAP_TIMEOUT_MS);
}

function clearGapTimeout(): void {
  if (gapTimeoutTimer !== null) {
    window.clearTimeout(gapTimeoutTimer);
    gapTimeoutTimer = null;
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
  try {
    callMicStream = await captureCallMic();
  } catch (error) {
    notifications.showToast({ title: "Call", channelName: username, body: `Microphone unavailable — ${errorMessage(error)}` });
    return;
  }
  appStore.patch({ callState: "ringing-out", callPeer: username, callHealthy: true, callSeconds: 0 });
  activeSession?.sendCallSignal({ type: "RING", to: username, sdp: null, candidate: null });
  notifications.startRingback();
  armRingTimeout();
  log.info("call", `RING → ${username}`);
}

async function establishCallerSession(peer: string): Promise<void> {
  const session = activeSession;
  const micStream = callMicStream;
  if (!session || micStream === null) {
    teardownCall();
    return;
  }
  appStore.patch({ callState: "connecting" });
  const iceServers = await fetchIceServers();
  callSession = new PeerCallSession({
    isCaller: true,
    peerUsername: peer,
    iceServers,
    micStream,
    sendSignal: (signal) => session.sendCallSignal(signal),
    callbacks: callCallbacks(peer),
  });
  drainPendingCallSignals();
  await callSession.startOffer();
  armGapTimeout();
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
  appStore.patch({ callState: "connecting" });
  try {
    callMicStream = await captureCallMic();
  } catch (error) {
    notifications.showToast({ title: "Call", channelName: peer, body: `Microphone unavailable — ${errorMessage(error)}` });
    teardownCall();
    return;
  }
  const iceServers = await fetchIceServers();
  callSession = new PeerCallSession({
    isCaller: false,
    peerUsername: peer,
    iceServers,
    micStream: callMicStream,
    sendSignal: (signal) => session.sendCallSignal(signal),
    callbacks: callCallbacks(peer),
  });
  session.sendCallSignal({ type: "ACCEPT", to: peer, sdp: null, candidate: null });
  drainPendingCallSignals();
  armGapTimeout();
}

export function rejectIncomingCall(): void {
  const state = appStore.getSnapshot();
  if (state.callState !== "ringing-in" || state.callPeer === null) {
    return;
  }
  activeSession?.sendCallSignal({ type: "REJECT", to: state.callPeer, sdp: null, candidate: null });
  teardownCall();
}

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
  clearRingTimeout();
  clearGapTimeout();
  stopCallTicker();
  if (callSession !== null) {
    callSession.close();
    callSession = null;
  }
  stopStream(callMicStream);
  stopStream(callCameraStream);
  stopStream(callDisplayStream);
  callMicStream = null;
  callCameraStream = null;
  callDisplayStream = null;
  roomAudio.detachFeed(CALL_VOICE_FEED_ID);
  roomAudio.detachFeed(CALL_SHARE_FEED_ID);
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
    peerMicOn: true,
    peerDeafenedOn: false,
    peerCameraOn: false,
    peerScreenOn: false,
  });
  callMicStateBeforeDeafen = true;
}

export function toggleCallMic(): void {
  if (callSession !== null) {
    callSession.setMicEnabled(!callSession.isMicEnabled());
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
  roomAudio.setDeafened(nowDeafened);
  if (session === null) {
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
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
        video: { deviceId: { exact: target.id }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      await session.setCameraStream(cameraStream);
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
    await window.spaceCapture?.select(target.id, target.kind === "screen");
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: target.kind === "screen" ? { channelCount: { ideal: 2 } } : false,
    });
    callDisplayStream = display;
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      void stopCallShareInternal();
    });
    await session.startShare(display);
    appStore.patch({ callSharing: true });
  } catch (error) {
    log.error("call", `call share failed: ${errorMessage(error)}`);
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
      { key: "call", value: state.callState !== "idle" ? `${state.callState} → ${state.callPeer ?? "?"} (${state.callHealthy ? "healthy" : "reconnecting"})` : "—" },
      { key: "sub conn", value: sfuSession?.getSubscriberConnectionState() ?? "—" },
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
