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
  DEFAULT_NOTIFICATION_PREFS,
  EXPIRED_MARKER,
  normalizeHostUrl,
  RecordTokenStorage,
} from "../domain/session/connection-record";
import { ConnectionSession, type SessionHooks } from "../domain/session/connection-session";
import { MAX_VOICE_REJOIN_ATTEMPTS, rejoinDelayMs, rejoinExhausted } from "../domain/logic/rejoin-ladder";
import { dmDisplayName } from "../domain/logic/dm-display";
import type { MentionIdentity } from "../domain/logic/notification-decider";
import { dmToastHeader, toastServerHeader } from "../domain/logic/toast-preview";
import { paletteColor } from "../domain/logic/user-palette";
import { displayNameOf } from "../domain/logic/display-name";
import { SettingsStore } from "../domain/stores/SettingsStore";
import type { NotificationPrefs } from "../types";
import { notifications } from "./notifications";
import {
  bindLiveBackgroundSession,
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
  viewingUsername: string | null;
  /** The voice ROOM VIEW occupies the chat area (oak: swap-in by clicking the voice bar). */
  roomViewOpen: boolean;
  diagOpen: boolean;
  stompState: "off" | "connecting" | "connected" | "lost";
  /** 1-based while a reconnect is scheduled/flying (0 = none) — "M/10". */
  stompAttempt: number;
  /** Seconds left until the scheduled attempt fires (null = no countdown). */
  stompCountdown: number | null;
  /** Server settings screen (in-app, replaces the content area) — M7. */
  serverSettingsOpen: boolean;
  serverSettingsSection: "overview" | "roles" | "members" | "channels";
  /** User settings modal — M7. */
  userSettingsOpen: boolean;
  /** A DM on a NON-active instance the user clicked in the aggregated list:
   *  consumed by openSession once that instance is up (oak's pendingOpenDm). */
  pendingOpenDm: { recordId: string; dmId: number } | null;
  /** A SERVER channel on a NON-active instance (a background toast click) —
   *  consumed by openSession after start, same contract as pendingOpenDm. */
  pendingOpenChannel: { recordId: string; channelId: number } | null;
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
    viewingUsername: null,
    roomViewOpen: false,
    diagOpen: false,
    stompState: "off",
    stompAttempt: 0,
    stompCountdown: null,
    serverSettingsOpen: false,
    serverSettingsSection: "overview",
    userSettingsOpen: false,
    pendingOpenDm: null,
    pendingOpenChannel: null,
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

/** Wiring point for the imperative voice view (tiles) — set by VoiceRoom. */
export const voiceView = {
  attachShareVideo(username: string, track: MediaStreamTrack): void {
    void username; void track;
  },
  dropShareVideo(): void {
    // replaced by VoiceRoom at mount
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
      appStore.patch({ loginFormOpen: true, loginError: "Session expired — log in again", userSettingsOpen: false });
    },
    onStompState: (state) => {
      if (isActive()) {
        appStore.patch({
          stompState: state,
          ...(state === "connected" ? { stompAttempt: 0, stompCountdown: null } : {}),
        });
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
    onMemberKicked: (event) => {
      const reason = event.banned
        ? `You were banned by ${event.by}. A moderator must unban you before reconnecting.`
        : `You were removed from the server by ${event.by}. Click the server again to reconnect.`;
      if (!isActive()) {
        log.warn("app", `${event.banned ? "banned" : "kicked"} on a background server (record ${recordId}) — dropping the session`);
        disposeBackgroundSession(recordId);
        notifications.showToast({ title: event.banned ? "Banned" : "Removed from server", channelName: event.by, body: reason });
        return;
      }
      // Tokens survive a kick (only a BAN kills them at the REST layer) — dropping
      // to the login modal keeps the record one click away, oak's ErrorDialog parity.
      const record = connectionDirectory.get(recordId);
      void teardownSession().finally(() => {
        appStore.patch({
          loginFormOpen: true,
          loginError: reason,
          loginPrefill: record !== null ? { url: record.hostUrl, username: record.username } : null,
          userSettingsOpen: false,
        });
        notifications.showToast({ title: event.banned ? "Banned" : "Removed from server", channelName: event.by, body: reason });
      });
    },
  };
}

/** App entry: load the directory, auto-resume the most recently used connection. */
export async function bootstrapApp(): Promise<void> {
  await settingsStore.load();
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
      log.info("app", `auto-resume failed (${errorMessage(error)}) — login screen`);
    }
  }
  // Every other record comes up as a LIVE background session (oak phase 2).
  startBackgroundSessions();
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
      loginFormOpen: true,
      loginError: errorMessage(error),
      loginPrefill: { url: record.hostUrl, username: record.username },
    });
  } finally {
    appStore.patch({ loginBusy: false });
  }
}

export async function removeConnection(recordId: string): Promise<void> {
  if (activeSession?.recordId === recordId) {
    // Removing the ACTIVE server leaves an empty main window (the rail with its
    // "+" stays) — no login modal: the user deliberately dropped the server.
    await teardownSession();
  } else {
    disposeBackgroundSession(recordId);
  }
  socialDirectory.drop(recordId);
  await connectionDirectory.remove(recordId);
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

/** "+" on the rail: the login modal with an empty form (the live session stays alive). */
export function beginAddServer(): void {
  appStore.patch({ loginFormOpen: true, loginError: null, loginPrefill: null });
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
    if (demoted !== null && demoted !== existing && !demoted.isDisposed()) {
      sessionMap.set(demoted.recordId, demoted);
    }
    sessionBinding.set(existing);
    appStore.patch({
      loginFormOpen: false,
      loginError: null,
      loginPrefill: null,
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
  try {
    await session.start();
    session.attachmentCache.setDiskBudget(settingsStore.getSnapshot().imageCacheMegabytes * 1024 * 1024);
    roomAudio.setOutputDevice(settingsStore.getSnapshot().speakerDeviceId); // the saved sink, before any chain attaches
    notifications.setOutputDevice(settingsStore.getSnapshot().speakerDeviceId); // UI sounds follow the same speaker (oak's playout line)
    appStore.patch({
      loginFormOpen: false,
      loginError: null,
      loginPrefill: null,
      ownUsername: record.username,
      baseUrl: record.hostUrl,
    });
    // A DM/channel clicked on a NON-active instance: open it instead of the
    // restored last channel (oak's pendingOpenDm).
    consumePendingOpen(session);
    roomAudio.startLevelPolling();
    await roomAudio.resume();
    // Bring every other record up as a LIVE background session; the REST
    // snapshot loader only covers records that cannot hold a session.
    void startBackgroundSessions();
  } catch (error) {
    await teardownSession();
    throw error;
  }
}

/** Start (once) a background session for every saved record that has none. */
function startBackgroundSessions(): void {
  for (const record of connectionDirectory.getSnapshot()) {
    if (record.token === EXPIRED_MARKER || record.refreshToken === "" || record.id === activeSession?.recordId) {
      continue;
    }
    if (sessionMap.has(record.id)) {
      continue;
    }
    const session = new ConnectionSession({ directory: connectionDirectory, recordId: record.id, hooks: makeSessionHooks(record.id) });
    sessionMap.set(record.id, session);
    bindLiveBackgroundSession(session, connectionDirectory);
    void session.start().catch((error: unknown) => {
      log.warn("app", `background session for ${record.username} @ ${record.hostUrl} failed (${errorMessage(error)}) — REST snapshots only`);
      disposeBackgroundSession(record.id);
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
  session.dispose();
  unbindLiveBackgroundSession(recordId);
  // A live background-call card dies with its session (nothing to accept on).
  if (backgroundRing !== null && backgroundRing.recordId === recordId) {
    clearBackgroundRing();
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
  if (dying !== null) {
    sessionMap.delete(dying.recordId);
    dying.dispose();
  }
  appStore.patch({
    stompState: "off",
    stompAttempt: 0,
    stompCountdown: null,
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
    serverSettingsOpen: false,
    // pendingOpenDm/pendingOpenChannel deliberately survive too — a switch that lands on the login
    // modal should still open the clicked DM once the user re-logs in.
    // userSettingsOpen is deliberately NOT reset here: the username rename
    // restarts the session WITH the settings window open (oak keeps it). Every
    // path that truly kills the session closes it explicitly (expired, kicked).
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
  ackActiveChannel(); // oak acks the channel being LEFT before the switch lands
  appStore.patch({ activeChannelId: channelId, dmMode: false, activeDmId: null, roomViewOpen: false });
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
    if (session.channelStore.get(pendingChannel.channelId) !== null) {
      setActiveChannel(pendingChannel.channelId);
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

/** oak's canManageAnySettings — gates the Server Settings entry point. */
export function canManageServerSettings(session: ConnectionSession | null): boolean {
  if (session === null) {
    return false;
  }
  const permissions = session.permissionStore.getSnapshot().my?.permissions ?? [];
  return permissions.some((name) =>
    name === "MANAGE_ROLES" || name === "MANAGE_MEMBERS" || name === "KICK_MEMBERS"
    || name === "BAN_MEMBERS" || name === "MANAGE_CHANNELS");
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
  appStore.patch({ userSettingsOpen: !appStore.getSnapshot().userSettingsOpen });
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
  appStore.patch({ dmMode: true, activeDmId: channelId, roomViewOpen: false });
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
    if (settingsStore.getSnapshot().soundEnabled) { // the app sound switch (ding + knocks)
      notifications.playKnock("join");
    }
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
      sfu.apmEnabled = settingsStore.getSnapshot().apmEnabled; // takes effect on this start()
      sfu.microphoneDeviceId = settingsStore.getSnapshot().microphoneDeviceId;
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
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null, roomViewOpen: false });
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
  appStore.patch({ activeVoiceChannelId: null, voiceState: "idle", stateDetail: null, participants: [], viewingFeedId: null, viewingUsername: null, roomViewOpen: false });
  if (hadSession && settingsStore.getSnapshot().soundEnabled) { // the app sound switch (ding + knocks)
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
  const pickedCamera = settingsStore.getSnapshot().cameraDeviceId;
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

let callSession: PeerCallSession | null = null;
let callMicStream: MediaStream | null = null;
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

/** Wiring point for the room view's imperative peer-video element (call mode). */
export const callView = {
  attachPeerVideo(_track: MediaStreamTrack): void {
    // replaced by RoomView at mount (call mode)
  },
  dropPeerVideo(): void {
    // replaced by RoomView at mount (call mode)
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
  const settings = settingsStore.getSnapshot();
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: settings.apmEnabled,
      noiseSuppression: settings.apmEnabled,
      autoGainControl: settings.apmEnabled,
      ...(settings.microphoneDeviceId !== null ? { deviceId: { exact: settings.microphoneDeviceId } } : {}),
    },
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
  try {
    callMicStream = await captureCallMic();
  } catch (error) {
    notifications.showToast({ title: "Call", channelName: peer, body: `Microphone unavailable — ${errorMessage(error)}` });
    teardownCall();
    return;
  }
  attachOwnCallMic(callMicStream);
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

// The toast window's call-card buttons land here (relayed by main): the ACTIVE
// ring answers in place; a BACKGROUND ring switches the instance first (#475).
notifications.setCallActionHandler((action) => {
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
});

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
  stopStream(callMicStream);
  stopStream(callCameraStream);
  stopStream(callDisplayStream);
  callMicStream = null;
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
  const session = callSession;
  if (session !== null) {
    const next = !session.isMicEnabled();
    session.setMicEnabled(next);
    appStore.patch({ callMicOn: next });
    return;
  }
  // Pre-accept (ringing-out): the mic is ALREADY captured — gate the track
  // directly; the PeerCallSession inherits the gate (its micEnabled reads the
  // track) and re-announces it to the peer once the offer flies.
  const track = callMicStream?.getAudioTracks()[0] ?? null;
  if (track) {
    track.enabled = !track.enabled;
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
  const pickedCamera = settingsStore.getSnapshot().cameraDeviceId;
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
