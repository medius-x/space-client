import { log } from "../../logging";
import { ApiError, RestClient } from "../../core/rest";
import { StompClient } from "../../core/stomp";
import type {
  CallIceCandidate,
  CallSignalType,
  Channel,
  Discussion,
  DiscussionEvent,
  DmChannel,
  DmChannelEvent,
  IncomingCallSignal,
  IncomingVoiceInvite,
  InvitesStatus,
  MemberKickEvent,
  Message,
  OwnershipEvent,
  PendingOwnershipTransfer,
  PingEcho,
  PresenceEvent,
  ReactionEvent,
  Relationship,
  Role,
  ServerProfile,
  Sticker,
  UserSummary,
  VoiceControlCommand,
  VoiceControlEvent,
  VoiceControlState,
  VoiceMemberEvent,
} from "../../types";
import { ChannelStore } from "../stores/ChannelStore";
import { MessageStore } from "../stores/MessageStore";
import { MemberStore } from "../stores/MemberStore";
import { PermissionStore } from "../stores/PermissionStore";
import { PinnedStore } from "../stores/PinnedStore";
import { DiscussionsStore } from "../stores/DiscussionsStore";
import { EmojiStore } from "../stores/EmojiStore";
import { StickerStore } from "../stores/StickerStore";
import { InvitesStore } from "../stores/InvitesStore";
import { OwnershipStore } from "../stores/OwnershipStore";
import { ReadStateStore } from "../stores/ReadStateStore";
import { RosterStore } from "../stores/RosterStore";
import { SocialStore } from "../stores/SocialStore";
import { VoiceControlStore } from "../stores/VoiceControlStore";
import { CoalescingRefresher } from "../lib/refresher";
import { AttachmentCache } from "../../media/attachment-cache";
import { PlaybackService } from "../../media/playback";
import { generateVideoPreview } from "../../media/video-thumbnail";
import { measureImageSize } from "../../media/image-size";
import { isImageFile, isVideoFile } from "../logic/attachment-layout";
import { sanitizeSlotFileName } from "../logic/ascii-name";
import { ConnectionQuality, type ConnectionQualitySnapshot } from "../logic/connection-quality";
import { ConnectionDirectory, RecordTokenStorage } from "./connection-record";

/** Fires into the app shell (runtime.ts) — the session never touches UI state itself. */
export interface SessionHooks {
  onSessionExpired(recordId: string): void;
  onStompState(state: "connecting" | "connected" | "lost"): void;
  /** Per-second while an attempt is scheduled: oak's "Reconnecting in Ns… M/10". */
  onStompCountdown?(secondsLeft: number, attempt: number): void;
  /** A reconnect attempt is leaving (1-based). */
  onStompAttempt?(attempt: number): void;
  /** The 10-attempt ladder stopped — terminal "Connection lost" until ↻. */
  onStompExhausted?(): void;
  /** After every (re)connect — the runtime re-sends /app/voice.join if a room is live. */
  onStompConnected(): void;
  /** A channel vanished (deleted or hidden) — the runtime re-homes the active chat/voice. */
  onChannelGone(channelId: number): void;
  /** After a diff-refetch applied (rename/override pings) — re-validate active channel. */
  onChannelsChanged(): void;
  /** A live message actually INSERTED into a loaded channel (echo-deduped). */
  onLiveMessage(message: Message): void;
  /** /topic/voice.state for the LOGGED-IN user — the runtime applies mic/deafen compliance. */
  onOwnVoiceControlState(state: VoiceControlState): void;
  /** A /topic/voice delta — the runtime knocks when SOMEONE ELSE joins or
   *  leaves the room the user is in (own knocks play at the join/leave site). */
  onVoiceMemberEvent?(event: VoiceMemberEvent): void;
  /** /user/queue/voice.control type=KICKED — the runtime tears the voice session down. */
  onVoiceKicked(byUsername: string): void;
  /** /user/queue/voice.control type=MOVED (the AFK sweep) — the runtime re-joins
   *  into the given channel (the membership already moved server-side). */
  onVoiceMoved?(channelId: number): void;
  /** A relayed 1:1 call signal (RING/ACCEPT/OFFER/ICE/…) — the runtime owns the call machine. */
  onCallSignal(signal: IncomingCallSignal): void;
  /** /user/queue/voice.invite — someone invited this user into a voice channel
   *  (the sidebar hover button). The runtime shows the toast-window card. */
  onVoiceInvite?(invite: IncomingVoiceInvite): void;
  /** A DM vanished (closed everywhere or left by me) — the runtime re-homes the open chat. */
  onDmClosed(channelId: number): void;
  /** A discussion lifecycle event on a parent channel's .discussions topic — the runtime
   *  kicks an open view closed on REMOVED and pings the origin author on the first reply. */
  onDiscussionEvent?(event: DiscussionEvent): void;
  /** A live message posted into an OPEN discussion (its own topic family): the runtime
   *  runs MENTION detection only — thread unread never feeds the parent's badge, and
   *  non-mention messages stay silent (only the mention toast/bell path fires). */
  onDiscussionLiveMessage?(message: Message): void;
  /** /user/queue/member.kick — the SERVER removed me: the runtime tears the session down. */
  onMemberKicked(event: MemberKickEvent): void;
  /** /user/queue/ownership — the ownership-transfer lifecycle changed (offered to me,
   *  accepted, declined, cancelled). The runtime toasts on a received accept; the
   *  pending banner rides the OwnershipStore refetch either way. */
  onOwnershipEvent?(event: OwnershipEvent): void;
  /** The connection-quality indicator moved (ping echo, missed echo, reconnect
   *  reset — see the ping cycle in ConnectionSession). The runtime mirrors the
   *  ACTIVE session's snapshot into the app store for the user bar. */
  onConnectionQuality?(snapshot: ConnectionQualitySnapshot): void;
}

export interface ConnectionSessionOptions {
  directory: ConnectionDirectory;
  recordId: string;
  hooks: SessionHooks;
  /** Seam for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** History page size for the initial load (oak's INITIAL_HISTORY_LIMIT). */
const INITIAL_HISTORY_LIMIT = 100;
/** Scroll-up / back-fill page size (oak's HISTORY_PAGE). */
export const HISTORY_PAGE = 50;
/** The around window's size (the search-result jump: a centered page). */
export const AROUND_LIMIT = 50;
/** Downward page size away from an around window (towards the live tail). */
export const NEWER_PAGE = 50;
/** Newest-page size a reconnect gap-heal refetches per loaded channel. A gap
 *  wider than this leaves holes in the middle — that is no longer a blip. */
const RESYNC_TAIL_LIMIT = 100;
/** Idle media prefetch: how many loads fly at once (see scheduleMediaPrefetch). */
const MEDIA_PREFETCH_CONCURRENCY = 2;
/** Prefetch budget in OBJECTS per sweep. The first sweep ran UNBOUNDED over
 *  every loaded message — a heavy channel downloaded 200+ MB of full-size
 *  originals in the first seconds after opening (live [media] activity log,
 *  2026-09-25: 164 fetches / 221691KB in one 5s window). Warming the nearest
 *  screenful is the point; the rest loads lazily on scroll. */
const MEDIA_PREFETCH_MAX_ITEMS = 24;
/** The latest scheduled media-prefetch sweep — a newer call aborts the older one. */
let mediaPrefetchRunCounter = 0;

/** Connection-quality ping cadence — 10 s keeps the indicator reactive while
 *  costing the server one in-memory routing hop per client (raised from 25 s
 *  on request; the keepalive role belongs to the heartbeat, not the ping). */
const PING_INTERVAL_MS = 10_000;
/** An echo later than this counts as missed — well under the interval, so a
 *  degraded connection flags before the next ping is even due. */
const PING_ECHO_TIMEOUT_MS = 10_000;
const PING_DESTINATION = "/app/ping";
const PING_ECHO_DESTINATION = "/user/queue/ping";

function toWsUrl(hostUrl: string): string {
  return hostUrl.replace(/^http/, "ws") + "/ws";
}

/**
 * One live server connection: REST client, STOMP client and the per-connection
 * stores, plus the record's token storage. v1 keeps a single ACTIVE session in the
 * app (switching = dispose + start); activate()/deactivate() mark the seam so M8's
 * background sessions do not force a re-architecture.
 */
export class ConnectionSession {
  readonly recordId: string;
  readonly rest: RestClient;
  readonly stomp: StompClient;
  readonly channelStore = new ChannelStore();
  readonly messageStore = new MessageStore();
  readonly pinnedStore = new PinnedStore();
  readonly discussionsStore = new DiscussionsStore();
  readonly emojiStore = new EmojiStore();
  readonly stickerStore = new StickerStore();
  readonly invitesStore = new InvitesStore();
  /** The live ownership-transfer offer (GET /api/ownership/pending + /user/queue/ownership). */
  readonly ownershipStore = new OwnershipStore();
  readonly rosterStore = new RosterStore();
  readonly memberStore = new MemberStore();
  readonly socialStore = new SocialStore();
  readonly permissionStore = new PermissionStore();
  readonly readStateStore = new ReadStateStore();
  readonly voiceControlStore = new VoiceControlStore();
  readonly attachmentCache = new AttachmentCache(() => (this.disposed ? null : this.rest));
  readonly playback = new PlaybackService();
  /**
   * The live server profile (name + avatar) from GET /api/server and
   * /topic/server pushes — the rail reads the presigned avatarUrl from here for
   * the ACTIVE record; inactive records render from the disk cache by key.
   */
  serverProfile: ServerProfile | null = null;
  /**
   * Relationship/DM lists are event→refetch fed (oak's pattern), coalesced so a
   * burst of pushes never runs parallel fetches that could land out of order.
   */
  private readonly socialRefresh = new CoalescingRefresher(() => this.doRefreshSocial());
  private readonly memberRefresh = new CoalescingRefresher(() => this.doRefreshMembers());
  /** The custom-emoji catalog: fetched once on start, refetched on /topic/emojis pings
   *  (any catalog mutation broadcasts one). A 404 marks the server too old — the
   *  feature hides (picker button, settings section). */
  private readonly emojiRefresh = new CoalescingRefresher(() => this.doRefreshEmojis());
  private readonly stickerRefresh = new CoalescingRefresher(() => this.doRefreshStickers());
  /** The invite list: NOT fetched on start (admins-only read; the section pulls its
   *  first snapshot), only refetched on /topic/invites pings and on demand. */
  private readonly invitesRefresh = new CoalescingRefresher(() => this.doRefreshInvites());
  /** The ownership-transfer offer: fetched on start (a pending offer must survive the
   *  recipient being offline) and refetched on every /user/queue/ownership push. */
  private readonly ownershipRefresh = new CoalescingRefresher(() => this.doRefreshOwnership());

  private readonly directory: ConnectionDirectory;
  private readonly hooks: SessionHooks;
  private readonly tokenStorage: RecordTokenStorage;
  /** Pure state machine of the ping indicator (see the ping cycle methods below). */
  private readonly quality = new ConnectionQuality();
  /** The interval re-arming SEND /app/ping (null = cycle stopped). */
  private pingIntervalTimer: number | null = null;
  /** The miss deadline of the in-flight ping (null = no ping in flight). */
  private pingTimeoutTimer: number | null = null;
  /** Send timestamp of the in-flight ping (guards echo/timeout pairing). */
  private pingSentAtMillis: number | null = null;
  private readonly subscribedChannelIds = new Set<number>();
  /** Discussion channels whose topic family we hold (the OPEN one; StompClient has no
   *  unsubscribe, so the wire SUBSCRIBE lives until the socket — the set only guards
   *  duplicates, and the handlers are messageStore-only (harmless after the view closes). */
  private readonly subscribedDiscussionIds = new Set<number>();
  private disposed = false;

  constructor(options: ConnectionSessionOptions) {
    this.directory = options.directory;
    this.recordId = options.recordId;
    this.hooks = options.hooks;
    this.tokenStorage = new RecordTokenStorage(options.directory, options.recordId);
    const record = options.directory.get(options.recordId);
    this.rest = new RestClient({
      baseUrl: record?.hostUrl ?? "",
      tokenStorage: this.tokenStorage,
      fetchImpl: options.fetchImpl,
      onSessionExpired: () => this.hooks.onSessionExpired(this.recordId),
      // Passive RTT samples keep the ms readout alive on servers too old to
      // echo /app/ping — the tracker ignores them once real echoes flow.
      onRequestLatency: ({ millis }) => {
        if (this.quality.recordRestSample(millis)) {
          this.publishQuality();
        }
      },
    });
    this.stomp = new StompClient({
      url: toWsUrl(record?.hostUrl ?? ""),
      getAccessToken: () => this.tokenStorage.load()?.token ?? "",
      handlers: {
        onLost: (reason) => {
          log.warn("session", `STOMP lost: ${reason} (auto-reconnecting)`);
          this.hooks.onStompState("lost");
          // No echo can arrive on a dead socket — cancel the in-flight ping
          // WITHOUT counting a miss (the watchdog owns connection-death states).
          this.stopPingCycle();
        },
        onAttempt: (attempt) => {
          this.hooks.onStompAttempt?.(attempt);
        },
        onCountdown: (secondsLeft, attempt) => {
          this.hooks.onStompCountdown?.(secondsLeft, attempt);
        },
        onExhausted: () => {
          this.hooks.onStompExhausted?.();
        },
        onConnected: (reconnected) => {
          this.hooks.onStompState("connected");
          this.hooks.onStompConnected();
          this.startPingCycle();
          if (reconnected) {
            void this.resyncAfterReconnect();
          }
        },
      },
    });
  }

  username(): string {
    return this.directory.get(this.recordId)?.username ?? "?";
  }

  hostUrl(): string {
    return this.directory.get(this.recordId)?.hostUrl ?? "";
  }

  async start(): Promise<void> {
    // PRESENCE and VOICE MEMBERSHIP are deliberately NOT in this batch: their
    // /topic deltas fire on the server the moment they change, and a snapshot taken
    // BEFORE our SUBSCRIBE frame lands would miss every change in the window — the
    // other user then shows OFFLINE forever (live M5 smoke). Both are re-fetched
    // AFTER the subscriptions below, with deltas buffered while the fetch is flying.
    const [channels, users, profile, myPermissions, readStates] = await Promise.all([
      this.rest.getChannels(),
      this.rest.getUsers(),
      this.rest.getServerProfile().catch((error: unknown) => {
        log.warn("session", `server profile unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      this.rest.getMyPermissions().catch((error: unknown) => {
        // Without the snapshot the client degrades to optimistic UI (server 403 guards).
        log.warn("session", `my permissions unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      this.rest.getReadStates().catch((error: unknown) => {
        log.warn("session", `read states unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    ]);
    this.channelStore.applySnapshot(channels);
    this.rosterStore.setUsers(users);
    if (profile) {
      this.serverProfile = profile;
      void this.directory.update(this.recordId, { cachedServerName: profile.name, cachedServerAvatarKey: profile.avatarKey });
    }
    if (myPermissions) {
      this.permissionStore.applyMy(myPermissions);
    }
    if (readStates) {
      this.readStateStore.applySnapshot(readStates);
    }
    this.playback.bindRest(() => (this.disposed ? null : this.rest));
    void this.directory.touch(this.recordId);

    this.hooks.onStompState("connecting");
    await this.stomp.connect();
    this.subscribeGlobalTopics();
    this.syncChannelSubscriptions();

    // Post-subscription snapshots: deltas arriving during the fetch ride the
    // pendingDeltas buffer inside the stores, so nothing is lost either side.
    this.rosterStore.beginPresenceSnapshot();
    void this.rest.getPresence()
      .then((presence) => {
        if (!this.disposed) {
          this.rosterStore.setPresence(presence);
        }
      })
      .catch((error: unknown) => {
        log.warn("session", `presence snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        this.rosterStore.abortPresenceSnapshot(); // unbuffer the deltas onto current state
      });
    void this.rest.getVoiceMembers()
      .then((voiceMembers) => {
        if (!this.disposed) {
          this.rosterStore.setVoiceMembers(voiceMembers);
        }
      })
      .catch((error: unknown) => {
        log.warn("session", `voice members snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      });

    // Same race guard for the social layer: /user/queue/relationships and
    // dm.channels fire on the server the moment they change — a snapshot taken
    // before the SUBSCRIBE frame lands would miss every change in the window.
    // The refreshers run post-subscribe, so the only events in flight ride the
    // coalescing queue and re-run afterwards.
    this.socialRefresh.request();
    this.memberRefresh.request();
    this.emojiRefresh.request();
    this.stickerRefresh.request();
    // A pending ownership offer must surface even though the recipient was OFFLINE
    // when it was made — the start-time snapshot is the whole point of the REST model.
    this.ownershipRefresh.request();
    // The tracked-discussions snapshot seeds the sidebar badges and the "mine" list from the
    // very first paint (live report: without it nothing showed until the user toggled the
    // sidebar to discussions and back — the only other mine-fetch site). The .discussions
    // topic subscriptions above keep it fresh from here on.
    void this.fetchMyDiscussions().catch((error: unknown) => {
      log.warn("session", `discussions snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    log.info("session", `connection up: ${this.username()} @ ${this.hostUrl()} (${channels.length} channels)`);
  }

  /** v1: one active session — deactivate disposes. Kept for the M8 background-session seam. */
  activate(): void {
    // nothing background-y yet
  }

  deactivate(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.playback.stop();
    this.stopPingCycle();
    this.stomp.disconnect();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // ---------------------------------------------------------------------------
  // Connection quality (the ping indicator)
  // ---------------------------------------------------------------------------

  /**
   * The RTT cycle: SEND /app/ping carrying Date.now() every PING_INTERVAL_MS,
   * the server echoes the value verbatim on /user/queue/ping and the tracker
   * folds now − echo into the indicator. Started on EVERY (re)connect; stopped
   * on loss/dispose and when the connection turns out to be "unsupported" (a
   * server build without the mapping silently drops the SENDs — probing it
   * forever would be pure noise; a reconnect re-probes).
   */
  private startPingCycle(): void {
    this.stopPingCycle();
    if (this.quality.reset()) {
      this.publishQuality();
    }
    // The echo subscription MUST exist before the first SEND: on the INITIAL
    // connect this runs from onConnected, which fires BEFORE start()'s
    // subscribeGlobalTopics() — a ping sent unsubscribed would lose its echo
    // and read as a false miss. subscribe() is wire-deduped by destination and
    // replays with every reconnect, so repeating it here is safe.
    this.stomp.subscribe(PING_ECHO_DESTINATION, (raw) => this.onPingEcho(raw));
    this.sendPing();
    this.pingIntervalTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopPingCycle(): void {
    if (this.pingIntervalTimer !== null) {
      window.clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
    if (this.pingTimeoutTimer !== null) {
      window.clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
    this.pingSentAtMillis = null;
  }

  private sendPing(): void {
    if (this.disposed || !this.stomp.isConnected() || this.pingSentAtMillis !== null) {
      return; // dead session, dead socket, or the previous ping still in flight
    }
    this.pingSentAtMillis = Date.now();
    this.stomp.send(PING_DESTINATION, this.pingSentAtMillis);
    this.pingTimeoutTimer = window.setTimeout(() => {
      this.pingTimeoutTimer = null;
      this.pingSentAtMillis = null;
      if (this.quality.recordTimeout()) {
        this.publishQuality();
      }
      if (this.quality.snapshot().state === "unsupported") {
        this.stopPingCycle(); // old server — nobody will echo; a reconnect re-probes
      }
    }, PING_ECHO_TIMEOUT_MS);
  }

  private onPingEcho(raw: string): void {
    if (this.pingSentAtMillis === null) {
      return; // a stale echo after the timeout already counted the miss
    }
    const sentAtMillis = JSON.parse(raw) as PingEcho;
    if (sentAtMillis !== this.pingSentAtMillis) {
      // A straggler of the PREVIOUS ping: the miss timeout equals the interval,
      // so it fires just as the next ping leaves — without pairing by VALUE the
      // late echo would be credited to the fresh ping as a bogus small RTT.
      return;
    }
    this.pingSentAtMillis = null;
    if (this.pingTimeoutTimer !== null) {
      window.clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
    if (this.quality.recordEcho(Date.now(), sentAtMillis)) {
      this.publishQuality();
    }
  }

  private publishQuality(): void {
    this.hooks.onConnectionQuality?.(this.quality.snapshot());
  }

  // ---------------------------------------------------------------------------
  // Chat + channel operations
  // ---------------------------------------------------------------------------

  async loadHistory(channelId: number): Promise<void> {
    if (this.disposed || this.messageStore.isLoaded(channelId)) {
      return;
    }
    const messages = await this.rest.getMessages(channelId, undefined, INITIAL_HISTORY_LIMIT);
    if (this.disposed) {
      return;
    }
    // A live message may have beaten the fetch in — insert dedups by id.
    if (!this.messageStore.isLoaded(channelId)) {
      this.messageStore.applySnapshot(channelId, messages);
      return;
    }
    for (const message of messages) {
      this.messageStore.applyLive(message);
    }
  }

  /**
   * Idle thumbnail prefetch (2026-09-25, the media round): warm the attachment
   * cache for the channel's LOADED messages on requestIdleCallback — thumbs
   * first (video previews are small and dominate scroll-in cost), then the
   * image bodies, capped to a small concurrency so an eager sweep cannot
   * starve the network. Already-cached and session-dead keys are skipped by
   * the cache itself (peek / the negative cache); a superseded call (a newer
   * sweep scheduled) aborts. Best-effort by design: nothing here is
   * load-bearing for correctness, only for scroll smoothness on real networks.
   */
  scheduleMediaPrefetch(channelId: number): void {
    if (this.disposed) {
      return;
    }
    const runId = ++mediaPrefetchRunCounter;
    const idle: (callback: () => void) => void = typeof requestIdleCallback === "function"
      ? (callback) => requestIdleCallback(callback)
      : (callback) => window.setTimeout(callback, 400);
    idle(() => {
      if (this.disposed || runId !== mediaPrefetchRunCounter) {
        return; // a newer sweep superseded this one
      }
      const queue: { key: string; url: string | null }[] = [];
      const messages = this.messageStore.listFor(channelId);
      // Newest first: the reader starts at the bottom — warming the tail of the
      // channel is what makes the first scroll smooth, not its head.
      for (let index = messages.length - 1; index >= 0 && queue.length < MEDIA_PREFETCH_MAX_ITEMS; index -= 1) {
        for (const attachment of messages[index]!.attachments) {
          if (queue.length >= MEDIA_PREFETCH_MAX_ITEMS) {
            break;
          }
          if (attachment.thumbnailKey !== null && attachment.thumbnailUrl !== null) {
            queue.push({ key: attachment.thumbnailKey, url: attachment.thumbnailUrl });
          } else if (isImageFile(attachment.fileName) && attachment.key !== null && attachment.url !== null) {
            queue.push({ key: attachment.key, url: attachment.url });
          }
        }
      }
      let next = 0;
      const launch = (): void => {
        if (this.disposed || runId !== mediaPrefetchRunCounter) {
          return;
        }
        while (next < queue.length) {
          const image = queue[next]!;
          next += 1;
          if (this.attachmentCache.peek(image.key) !== null) {
            continue; // already cached — free
          }
          void this.attachmentCache.loadImage(image).then(launch);
          return; // one in flight per worker slot; the completion re-arms
        }
      };
      for (let slot = 0; slot < MEDIA_PREFETCH_CONCURRENCY; slot += 1) {
        launch();
      }
    });
  }

  /** Fetch (once) the override-aware composer bits for a channel. */
  async ensureChannelPermissions(channelId: number): Promise<void> {
    if (this.disposed || this.permissionStore.channelPermissions(channelId) !== null) {
      return;
    }
    const permissions = await this.rest.getChannelMyPermissions(channelId);
    if (!this.disposed) {
      this.permissionStore.applyChannel(channelId, permissions);
    }
  }

  sendMessage(channelId: number, content: string, replyToId?: number): Promise<void> {
    // Optimistic send (user decision 2026-10-15, Discord-style, text-only): on a
    // loaded contiguous channel the text lands as a local temp row IMMEDIATELY
    // and this promise resolves at once — the composer clears instantly while
    // the POST continues in the background. No "sending" marker exists; failure
    // marks the row (red glyph + Retry/Remove). Attachments and stickers keep
    // the await-the-201 path (their render needs the server's URLs anyway).
    const ownUserId = this.selfUserId();
    if (ownUserId !== null
        && this.messageStore.isLoaded(channelId)
        && !this.messageStore.isAroundWithoutTail(channelId)) {
      // An around window must not pretend a temp row sits next to the window's
      // last message (the gap below is unknown) — those sends fall through to
      // the await path below, where a failure keeps the composer's draft.
      const idempotencyKey = crypto.randomUUID();
      const temp = this.messageStore.appendPending(channelId, {
        content,
        authorId: ownUserId,
        authorUsername: this.username(),
        replyToId: replyToId ?? null,
        idempotencyKey,
      });
      void this.rest.sendMessage(channelId, {
        content,
        replyToId: replyToId ?? null,
        idempotencyKey,
      })
        .then((created) => {
          this.messageStore.resolvePending(channelId, temp.id, created);
        })
        .catch((sendError: unknown) => {
          log.warn("chat", `optimistic send failed (row marked for retry): ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          this.messageStore.markPendingDelivery(channelId, temp.id, "failed");
        });
      return Promise.resolve();
    }
    // The await path (around window, cold channel, unknown self id): one key per
    // composer submission — a network retry of THIS send reuses it, and the
    // server returns the original message instead of a duplicate.
    return this.rest.sendMessage(channelId, {
      content,
      replyToId: replyToId ?? null,
      idempotencyKey: crypto.randomUUID(),
    })
      .then((created) => {
        this.messageStore.applyLive(created); // the STOMP echo dedups against this id
      });
  }

  /** Retry a failed optimistic row: same content, same reply target, SAME
   *  idempotency key — the server returns the original if the lost POST had
   *  actually landed, so a retry can never duplicate the message. */
  async retryPendingMessage(channelId: number, tempId: number): Promise<void> {
    const temp = this.messageStore.pendingMessageById(channelId, tempId);
    if (temp === null || temp.delivery !== "failed") {
      return;
    }
    this.messageStore.markPendingDelivery(channelId, tempId, "pending");
    try {
      const created = await this.rest.sendMessage(channelId, {
        content: temp.content ?? "",
        replyToId: temp.replyToId ?? null,
        idempotencyKey: temp.idempotencyKey ?? crypto.randomUUID(),
      });
      this.messageStore.resolvePending(channelId, tempId, created);
    } catch (retryError) {
      log.warn("chat", `retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      this.messageStore.markPendingDelivery(channelId, tempId, "failed");
    }
  }

  /** Remove a failed optimistic row — the user gives up on the text. */
  discardPendingMessage(channelId: number, tempId: number): void {
    this.messageStore.removePendingMessage(channelId, tempId);
  }

  /**
   * Upload a batch of files and send the message carrying them: per file —
   * mint a slot, PUT the bytes; videos additionally get a client-generated
   * JPEG preview (seek+canvas) uploaded as its own object. A failed preview
   * never blocks the send.
   */
  async sendMessageWithFiles(channelId: number, files: readonly File[], content: string | null, replyToId?: number): Promise<void> {
    const refs: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null; width: number | null; height: number | null; sizeBytes: number | null }[] = [];
    for (const file of files) {
      // The slot name feeds only the object KEY (the server 400s on non-ASCII);
      // the ORIGINAL name stays on the message as the display fileName.
      const slot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(file.name));
      await this.rest.uploadBytes(slot.uploadUrl, await file.arrayBuffer(), file.type || "application/octet-stream");
      const reference: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null; width: number | null; height: number | null; sizeBytes: number | null }
        = { key: slot.key, fileName: file.name, thumbnailKey: null, durationMillis: null, width: null, height: null, sizeBytes: file.size };
      if (isVideoFile(file.name)) {
        const preview = await generateVideoPreview(file);
        if (preview !== null) {
          const thumbSlot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(`${file.name}-preview.jpg`));
          await this.rest.uploadBytes(thumbSlot.uploadUrl, await preview.jpegBlob.arrayBuffer(), "image/jpeg");
          reference.thumbnailKey = thumbSlot.key;
          reference.durationMillis = preview.durationMillis;
          reference.width = preview.width;
          reference.height = preview.height;
        }
      } else if (isImageFile(file.name)) {
        const size = await measureImageSize(file);
        if (size !== null) {
          reference.width = size.width;
          reference.height = size.height;
        }
      }
      refs.push(reference);
    }
    const created = await this.rest.sendMessage(channelId, {
      content,
      attachments: refs,
      replyToId: replyToId ?? null,
      // The upload bytes are already on MinIO — a retried POST re-references
      // the SAME keys (no re-upload), and a duplicate message is prevented
      // server-side by the key.
      idempotencyKey: crypto.randomUUID(),
    });
    this.messageStore.applyLive(created);
  }

  /** An edit may also drop attachments: remainingAttachments ABSENT = a plain
   *  text edit (the server leaves the list untouched); a list = replace with
   *  exactly these (validated as a subset server-side — oak's edit flow). */
  async editMessage(channelId: number, messageId: number, content: string,
    remainingAttachments?: readonly { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null; sizeBytes?: number | null }[]): Promise<void> {
    const edited = await this.rest.editMessage(channelId, messageId, remainingAttachments === undefined
      ? { content }
      : {
        content,
        attachments: remainingAttachments.map((reference) => ({
          key: reference.key,
          fileName: reference.fileName,
          thumbnailKey: reference.thumbnailKey,
          durationMillis: reference.durationMillis,
          sizeBytes: reference.sizeBytes ?? null,
        })),
      });
    this.messageStore.applyEdited(edited);
  }

  async deleteMessage(channelId: number, messageId: number): Promise<void> {
    await this.rest.deleteMessage(channelId, messageId);
    this.messageStore.applyDeleted(channelId, messageId);
  }

  async toggleReaction(channelId: number, messageId: number, slug: string, mine: boolean): Promise<void> {
    const reactions = mine
      ? await this.rest.removeReaction(channelId, messageId, slug)
      : await this.rest.addReaction(channelId, messageId, slug);
    this.messageStore.applyReactions(channelId, messageId, reactions);
  }

  /** Fetch the channel's pin list once per channel (DMs included — the endpoint is the
   *  same); the .edited pushes keep it fresh afterwards. */
  async loadPinned(channelId: number): Promise<void> {
    if (this.disposed || this.pinnedStore.isLoaded(channelId)) {
      return;
    }
    const pins = await this.rest.getPinnedMessages(channelId);
    if (!this.disposed) {
      this.pinnedStore.applySnapshot(channelId, pins);
    }
  }

  /** Pin/unpin: the REST answer is applied immediately (message row + pin list); the
   *  .edited WS echo lands idempotently on top of both. A 400 (channel pin cap hit)
   *  propagates to the caller — it surfaces the toast. */
  async pinMessage(channelId: number, messageId: number): Promise<void> {
    const updated = await this.rest.pinMessage(channelId, messageId);
    this.messageStore.applyEdited(updated);
    this.pinnedStore.applyFromMessage(updated);
  }

  async unpinMessage(channelId: number, messageId: number): Promise<void> {
    const updated = await this.rest.unpinMessage(channelId, messageId);
    this.messageStore.applyEdited(updated);
    this.pinnedStore.applyFromMessage(updated);
  }

  // --- Discussions (threads) ---

  /** The channel's every discussion (the tiles under origin messages). Server TEXT channels
   *  only — DMs have no discussions. */
  async fetchChannelDiscussions(parentChannelId: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const discussions = await this.rest.getChannelDiscussions(parentChannelId);
    if (!this.disposed) {
      this.discussionsStore.applyParentSnapshot(parentChannelId, discussions);
    }
  }

  /** The viewer's tracked discussions — the sidebar's discussions list. */
  async fetchMyDiscussions(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const mine = await this.rest.getMyDiscussions();
    if (!this.disposed) {
      this.discussionsStore.applyMineSnapshot(mine);
    }
  }

  /** The LAZY-CREATE flow (user rule): "Start discussion" opens a local draft, and the
   *  first reply lands here — uploads (if any), then ONE create call carrying the content,
   *  so the discussion is born WITH its first message. A create race reuses the winner's
   *  thread server-side (the message is never lost — no 409 path exists for the client). */
  async startDiscussionWithMessage(parentChannelId: number, originMessageId: number,
    files: readonly File[], content: string | null): Promise<Discussion> {
    const refs: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null; width: number | null; height: number | null; sizeBytes: number | null }[] = [];
    for (const file of files) {
      const slot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(file.name));
      await this.rest.uploadBytes(slot.uploadUrl, await file.arrayBuffer(), file.type || "application/octet-stream");
      const reference: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null; width: number | null; height: number | null; sizeBytes: number | null }
        = { key: slot.key, fileName: file.name, thumbnailKey: null, durationMillis: null, width: null, height: null, sizeBytes: file.size };
      if (isVideoFile(file.name)) {
        const preview = await generateVideoPreview(file);
        if (preview !== null) {
          const thumbSlot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(`${file.name}-preview.jpg`));
          await this.rest.uploadBytes(thumbSlot.uploadUrl, await preview.jpegBlob.arrayBuffer(), "image/jpeg");
          reference.thumbnailKey = thumbSlot.key;
          reference.durationMillis = preview.durationMillis;
          reference.width = preview.width;
          reference.height = preview.height;
        }
      } else if (isImageFile(file.name)) {
        const size = await measureImageSize(file);
        if (size !== null) {
          reference.width = size.width;
          reference.height = size.height;
        }
      }
      refs.push(reference);
    }
    const created = await this.rest.createDiscussion(
      parentChannelId, originMessageId, content, refs, crypto.randomUUID());
    this.discussionsStore.applyParentSnapshot(parentChannelId,
      [created, ...this.discussionsStore.forParent(parentChannelId)]);
    return created;
  }

  /** Explicit follow — optimistic tracked flip, the 204 answer needs no merge. */
  async trackDiscussion(discussionId: number): Promise<void> {
    this.discussionsStore.setTracked(discussionId, true);
    await this.rest.trackDiscussion(discussionId);
  }

  /** Unfollow — optimistic flip first (personal only). */
  async untrackDiscussion(discussionId: number): Promise<void> {
    this.discussionsStore.setTracked(discussionId, false);
    await this.rest.untrackDiscussion(discussionId);
  }

  /** Close for everyone (MANAGE_MESSAGES via the parent). The local purge is immediate; the
   *  REMOVED echo on the parent topic is idempotent on top. */
  async closeDiscussion(discussionId: number): Promise<void> {
    await this.rest.closeDiscussion(discussionId);
    this.discussionsStore.dropDiscussion(discussionId);
    this.messageStore.dropChannel(discussionId);
    this.subscribedDiscussionIds.delete(discussionId);
  }

  /** Open a discussion: subscribe its topic family (messageStore-only — no unread/toast
   *  accounting) and load its history once per discussion id. */
  async openDiscussion(discussionId: number): Promise<void> {
    this.ensureDiscussionTopicFamily(discussionId);
    await this.loadHistory(discussionId);
  }

  /** Same-instance forward — the server copies content/attachments/origin itself. */
  async forwardMessage(targetChannelId: number, sourceMessageId: number, comment: string | null): Promise<void> {
    const forwarded = await this.rest.forwardMessage(targetChannelId, { sourceMessageId, content: comment });
    this.messageStore.applyLive(forwarded);
  }

  /**
   * Scroll-up pagination page. Returns the RAW page length (the caller latches
   * end-of-history on a short page — dedup must not fake it).
   */
  async loadOlder(channelId: number, beforeId: number): Promise<number> {
    const page = await this.rest.getMessages(channelId, beforeId, HISTORY_PAGE);
    if (this.disposed) {
      return 0;
    }
    this.messageStore.prependPage(channelId, page);
    return page.length;
  }

  /**
   * Open a channel ON a message: the around window REPLACES the channel's list
   * (jumping away from the tail discards it) and marks it around-without-tail.
   * A 404 (the message was deleted) propagates to the caller — it falls back to
   * a plain tail open.
   */
  async loadAround(channelId: number, messageId: number): Promise<void> {
    const window = await this.rest.getMessages(channelId, undefined, AROUND_LIMIT, { aroundId: messageId });
    if (this.disposed) {
      return;
    }
    this.messageStore.applySnapshotAround(channelId, window);
  }

  /**
   * Downward pagination away from an around window. Mirror of {@link loadOlder}:
   * returns the RAW page length — the caller latches "tail reached" on a short
   * page and clears the around flag.
   */
  async loadNewer(channelId: number, afterId: number): Promise<number> {
    const page = await this.rest.getMessages(channelId, undefined, NEWER_PAGE, { afterId });
    if (this.disposed) {
      return 0;
    }
    this.messageStore.appendPage(channelId, page);
    return page.length;
  }

  /**
   * "Jump to present": refetch the newest page as a PLAIN snapshot — clears any
   * around window (the list becomes the contiguous tail again) and re-enables
   * live appends.
   */
  async reloadTail(channelId: number): Promise<void> {
    const messages = await this.rest.getMessages(channelId, undefined, INITIAL_HISTORY_LIMIT);
    if (this.disposed) {
      return;
    }
    this.messageStore.applySnapshot(channelId, messages);
  }

  /** The read-state ack: local counters now, the REST call fire-and-forget. */
  ackChannelRead(channelId: number, lastReadMessageId: number | null): void {
    this.readStateStore.ack(channelId, lastReadMessageId);
    void this.rest.ackChannelRead(channelId, lastReadMessageId).catch((error: unknown) => {
      log.warn("chat", `read ack failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** The signed-in user's id — "is this reaction mine" and self-checks. */
  selfUserId(): number | null {
    const username = this.username();
    return this.rosterStore.getSnapshot().users.find((user) => user.username === username)?.id ?? null;
  }

  /** Creates a TEXT/VOICE channel (optionally grouped under a category) or a
   *  CATEGORY itself. Categories land in the store like any channel (the sidebar
   *  renders them) but never subscribe to channel topics. */
  async createChannel(request: { name: string; type: "TEXT" | "VOICE" | "CATEGORY"; parentId?: number | null }): Promise<Channel> {
    const channel = await this.rest.createChannel(request);
    if (this.channelStore.applyCreated(channel) && channel.type !== "CATEGORY") {
      this.syncChannelSubscriptions(); // subscribe the new channel's topics now
    }
    return channel;
  }

  /** The drag-drop persist: no local mutation — the server pings channels.changed
   *  after the commit and the refetch lands the new order through applySnapshot. */
  async reorderChannels(entries: readonly { id: number; parentId: number | null }[]): Promise<void> {
    await this.rest.reorderChannels(entries);
  }

  async renameChannel(channelId: number, name: string): Promise<Channel> {
    const channel = await this.rest.renameChannel(channelId, name);
    this.channelStore.applyUpdated(channel);
    return channel;
  }

  async deleteChannel(channelId: number): Promise<void> {
    await this.rest.deleteChannel(channelId);
    this.forgetChannel(channelId);
  }

  /** Local half of a channel removal (the /topic/channels.deleted echo dedups after it). */
  forgetChannel(channelId: number): void {
    if (this.channelStore.applyDeleted(channelId)) {
      this.messageStore.dropChannel(channelId);
      this.pinnedStore.dropChannel(channelId);
      // the channel's discussions die with it (their channel rows are not in channelStore —
      // drop their message lists and topic-guard entries one by one)
      for (const discussion of this.discussionsStore.forParent(channelId)) {
        this.messageStore.dropChannel(discussion.id);
        this.subscribedDiscussionIds.delete(discussion.id);
      }
      this.discussionsStore.dropParent(channelId);
      this.permissionStore.dropChannel(channelId);
      this.readStateStore.dropChannel(channelId);
      this.subscribedChannelIds.delete(channelId);
      this.hooks.onChannelGone(channelId);
    }
  }

  // ---------------------------------------------------------------------------
  // Voice control (self toggles + moderation)
  // ---------------------------------------------------------------------------

  /**
   * One send path for every voice-control command. The server routes self-targets
   * without a permission check; moderator targets are re-checked server-side (the
   * client's permission gating is a UI hint, never the authority).
   */
  sendVoiceControl(destination: "/app/voice.mute" | "/app/voice.deafen" | "/app/voice.kick", channelId: number, targetUsername: string, flags: { muted?: boolean; deafened?: boolean }): void {
    this.stomp.send(destination, {
      channelId,
      targetUsername,
      muted: flags.muted ?? null,
      deafened: flags.deafened ?? null,
    } satisfies VoiceControlCommand);
  }

  /** Send one call signal to a peer (the server stamps `from` and relays). */
  sendCallSignal(signal: { type: CallSignalType; to: string; sdp: string | null; candidate: CallIceCandidate | null }): void {
    this.stomp.send("/app/call.signal", signal);
  }

  /** One voice-room invitation (the sidebar's hover button): the server stamps
   *  the sender and resolves the channel name — only channelId/to travel. */
  sendVoiceInvite(channelId: number, to: string): void {
    log.info("voice-invite", `sending an invite to ${to} for channel #${channelId}`);
    this.stomp.send("/app/voice.invite", { channelId, channelName: null, from: null, to });
  }

  // ---------------------------------------------------------------------------
  // Social layer: friends, DMs, member moderation (M6)
  // ---------------------------------------------------------------------------

  /**
   * Self-performed relationship mutations get NO push back to the actor — every
   * action therefore ends with an explicit refresh (coalesced with any pushes
   * that did arrive).
   */
  async sendFriendRequest(username: string): Promise<Relationship> {
    const relationship = await this.rest.addFriend(username);
    this.socialRefresh.request();
    return relationship;
  }

  async acceptFriendRequest(userId: number): Promise<void> {
    await this.rest.acceptFriend(userId);
    this.socialRefresh.request();
  }

  /** Cancel / decline / unfriend — one idempotent endpoint. */
  async removeFriend(userId: number): Promise<void> {
    await this.rest.removeFriend(userId);
    this.socialRefresh.request();
  }

  async blockUser(username: string): Promise<void> {
    await this.rest.blockUser(username);
    this.socialRefresh.request();
  }

  async unblockUser(userId: number): Promise<void> {
    await this.rest.unblockUser(userId);
    this.socialRefresh.request();
  }

  /** Open (get-or-create) a 1:1 DM; the row lands locally — no push comes to the caller. */
  async openDmWith(recipientId: number): Promise<DmChannel> {
    const dm = await this.rest.createDm(recipientId);
    this.socialStore.mergeDm(dm);
    this.syncDmSubscriptions();
    return dm;
  }

  async createGroupDm(participantIds: number[]): Promise<DmChannel> {
    const dm = await this.rest.createGroupDm(participantIds, null);
    this.socialStore.mergeDm(dm);
    this.syncDmSubscriptions();
    return dm;
  }

  async renameDm(channelId: number, name: string): Promise<DmChannel> {
    const dm = await this.rest.renameDm(channelId, name);
    this.socialStore.mergeDm(dm);
    return dm;
  }

  async addDmParticipant(channelId: number, userId: number): Promise<DmChannel> {
    const dm = await this.rest.addDmParticipant(channelId, userId);
    this.socialStore.mergeDm(dm);
    return dm;
  }

  /**
   * Leave a group / be removed: the REMOVED member gets no event — drop the row
   * locally right away (the remaining participants refresh via their pushes).
   */
  async removeDmParticipant(channelId: number, userId: number): Promise<void> {
    await this.rest.removeDmParticipant(channelId, userId);
    if (userId === this.selfUserId()) {
      this.forgetDm(channelId);
    }
  }

  async closeDm(channelId: number): Promise<void> {
    await this.rest.closeDm(channelId);
    this.forgetDm(channelId); // local drop even if the CLOSED push never reaches us
  }

  /** Local half of a DM vanishing (closed/removed) — mirrors forgetChannel. */
  private forgetDm(channelId: number): void {
    this.socialStore.applyDmClosed(channelId);
    this.messageStore.dropChannel(channelId);
    this.readStateStore.dropChannel(channelId);
    this.subscribedChannelIds.delete(channelId);
    this.hooks.onDmClosed(channelId);
  }

  async removeMember(userId: number): Promise<void> {
    await this.rest.removeMember(userId);
  }

  async banMember(userId: number): Promise<void> {
    await this.rest.banMember(userId);
  }

  async unbanMember(userId: number): Promise<void> {
    await this.rest.unbanMember(userId);
    this.memberRefresh.request(); // the ban list refreshes via /topic/members anyway — this covers a missed push
  }

  /** Nickname mutation (the rename model): /topic/members + /topic/users
   *  pushes refresh the management roster and the display-name roster — the
   *  request covers a missed push. */
  async renameMember(userId: number, nickname: string): Promise<void> {
    await this.rest.renameMember(userId, nickname);
    this.memberRefresh.request();
  }

  async resetMemberNickname(userId: number): Promise<void> {
    await this.rest.resetMemberNickname(userId);
    this.memberRefresh.request();
  }

  // ---------------------------------------------------------------------------
  // RBAC editor (M7): roles CRUD/reorder — every mutation ends with the coalesced
  // member+roles refresh so all viewers (including this one) re-derive gates live
  // ---------------------------------------------------------------------------

  /** oak parity: creation is one click, defaults empty — naming/colors happen in the editor. */
  async createRole(name: string): Promise<Role> {
    const role = await this.rest.createRole({ name });
    this.memberRefresh.request();
    return role;
  }

  async updateRole(roleId: number, patch: {
    name?: string | null;
    permissions?: string[] | null;
    color?: number | null;
    mentionable?: boolean | null;
    hoist?: boolean | null;
  }): Promise<Role> {
    const role = await this.rest.updateRole(roleId, patch);
    this.memberRefresh.request();
    return role;
  }

  async deleteRole(roleId: number): Promise<void> {
    await this.rest.deleteRole(roleId);
    this.memberRefresh.request();
  }

  async reorderRoles(roleIds: readonly number[]): Promise<void> {
    await this.rest.reorderRoles(roleIds);
    this.memberRefresh.request();
  }

  private async doRefreshSocial(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const [relationships, dms] = await Promise.all([
      this.rest.getRelationships(),
      this.rest.getDmChannels(),
    ]);
    if (this.disposed) {
      return;
    }
    this.socialStore.setRelationships(relationships);
    this.socialStore.setDms(dms);
    this.syncDmSubscriptions();
  }

  private async doRefreshEmojis(): Promise<void> {
    if (this.disposed || !this.emojiStore.getSnapshot().supported) {
      return;
    }
    const emojis = await this.rest.getEmojis();
    if (this.disposed) {
      return;
    }
    if (emojis === null) {
      // The server predates the feature (404) — hide every surface, quietly.
      log.warn("session", "server has no custom-emoji endpoint — the feature stays hidden");
      this.emojiStore.markUnsupported();
      return;
    }
    this.emojiStore.applySnapshot(emojis);
  }

  /** Public re-fetch for the settings screen after its own mutations. */
  refreshEmojis(): void {
    this.emojiRefresh.request();
  }

  private async doRefreshStickers(): Promise<void> {
    if (this.disposed || !this.stickerStore.getSnapshot().supported) {
      return;
    }
    const packs = await this.rest.getStickerPacks();
    if (this.disposed) {
      return;
    }
    if (packs === null) {
      // The server predates the feature (404) — hide every surface, quietly.
      log.warn("session", "server has no sticker-pack endpoint — the feature stays hidden");
      this.stickerStore.markUnsupported();
      return;
    }
    this.stickerStore.applySnapshot(packs);
  }

  /** Public re-fetch for the settings screen after its own mutations. */
  refreshStickers(): void {
    this.stickerRefresh.request();
  }

  private async doRefreshInvites(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let status: InvitesStatus;
    try {
      status = await this.rest.getInvites();
    } catch (error: unknown) {
      // The /topic/invites ping reaches EVERY session, but only MANAGE_MEMBERS
      // holders may read the list — a 403 here is expected noise for plebeians,
      // not a log-worthy failure.
      if (error instanceof ApiError && error.status === 403) {
        return;
      }
      log.warn("session", `invites snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.disposed) {
      return;
    }
    this.invitesStore.applySnapshot(status.ttlMinutes, status.invites);
  }

  /** Public re-fetch for the settings section (its mount and own mutations). */
  refreshInvites(): void {
    this.invitesRefresh.request();
  }

  private async doRefreshOwnership(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let snapshot: PendingOwnershipTransfer;
    try {
      snapshot = await this.rest.getPendingOwnershipTransfer();
    } catch (error: unknown) {
      log.warn("session", `ownership snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.disposed) {
      return;
    }
    this.ownershipStore.applySnapshot(snapshot.pending);
  }

  /** The transfer actions (offer/accept/decline/cancel) — every caller refetches after. */
  async offerOwnershipTransfer(toUserId: number): Promise<void> {
    await this.rest.offerOwnershipTransfer(toUserId);
    this.ownershipRefresh.request();
  }

  async acceptOwnershipTransfer(transferId: number): Promise<void> {
    await this.rest.acceptOwnershipTransfer(transferId);
    this.ownershipRefresh.request();
  }

  async declineOwnershipTransfer(transferId: number): Promise<void> {
    await this.rest.declineOwnershipTransfer(transferId);
    this.ownershipRefresh.request();
  }

  async cancelOwnershipTransfer(transferId: number): Promise<void> {
    await this.rest.cancelOwnershipTransfer(transferId);
    this.ownershipRefresh.request();
  }

  /** Sends a sticker message (the tray's click-to-send): content null, the sticker id
   *  rides the normal message POST. An armed reply carries over; the composer's text
   *  draft is NOT consumed. */
  async sendMessageWithSticker(channelId: number, sticker: Sticker, replyToId?: number): Promise<void> {
    const created = await this.rest.sendMessage(channelId, {
      content: null,
      stickerId: sticker.id,
      replyToId: replyToId ?? null,
      idempotencyKey: crypto.randomUUID(),
    });
    this.messageStore.applyLive(created);
  }

  private async doRefreshMembers(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const [members, roles] = await Promise.all([
      this.rest.getMembers(),
      this.rest.getRoles(),
    ]);
    if (this.disposed) {
      return;
    }
    this.memberStore.setMembers(members);
    this.memberStore.setRoles(roles);
    // M7 live tracking: a role edit can flip THE VIEWER's own gates — refresh
    // my-permissions and every cached channel bit along with the roster (oak's
    // loadMyPermissionsIfNeeded after /topic/roles).
    await this.refreshPermissions();
  }

  // ---------------------------------------------------------------------------
  // STOMP topic wiring
  // ---------------------------------------------------------------------------

  private subscribeGlobalTopics(): void {
    this.stomp.subscribe("/topic/presence", (raw) => {
      this.rosterStore.applyPresenceEvent(JSON.parse(raw) as PresenceEvent);
    });
    this.stomp.subscribe("/topic/users", (raw) => {
      // Avatar confirm/remove AND renames push the updated user to everyone.
      // A rename also repaints the social snapshots (friends/DM rows) — no
      // relationship event follows a rename, so the snapshot would go stale.
      const user = JSON.parse(raw) as UserSummary;
      const previous = this.rosterStore.getSnapshot().users.find((entry) => entry.id === user.id) ?? null;
      this.rosterStore.updateUser(user);
      this.socialStore.applyUserRename(user.username, user.displayName ?? user.username);
      // A LOGIN change (the removal tombstone): already-loaded messages still carry
      // the old authorUsername, which no longer matches any roster row — repoint them
      // to the new login so the author keeps rendering through the live roster.
      if (previous !== null && previous.username !== user.username) {
        this.socialStore.applyUserRename(previous.username, user.displayName ?? user.username);
        this.messageStore.renameAuthor(user.id, user.username);
        log.info("session", `user ${previous.username} renamed to ${user.username} — repointed loaded messages`);
      }
    });
    this.stomp.subscribe("/topic/voice", (raw) => {
      const event = JSON.parse(raw) as VoiceMemberEvent;
      this.rosterStore.applyVoiceEvent(event);
      if (event.status === "LEFT") {
        // Their rows vanish; moderator marks survive server-side and re-publish on re-entry.
        this.voiceControlStore.clearUser(event.username);
      }
      this.hooks.onVoiceMemberEvent?.(event);
      log.info("voice", `${event.username} ${event.status.toLowerCase()} channel #${event.channelId}`);
    });
    this.stomp.subscribe("/topic/voice.state", (raw) => {
      const state = JSON.parse(raw) as VoiceControlState;
      this.voiceControlStore.applyState(state);
      if (state.username === this.username()) {
        this.hooks.onOwnVoiceControlState(state);
      }
    });
    this.stomp.subscribe("/user/queue/voice.control", (raw) => {
      const event = JSON.parse(raw) as VoiceControlEvent;
      if (event.type === "KICKED") {
        log.warn("voice", `kicked from channel #${event.channelId} by ${event.byUsername}`);
        this.hooks.onVoiceKicked(event.byUsername ?? "server");
      } else if (event.type === "MOVED") {
        // The AFK sweep: the tracker already re-pointed this member's membership —
        // the runtime re-joins into the new channel (a fresh /room, fresh media).
        log.info("voice", `moved to channel #${event.channelId} (afk sweep)`);
        this.hooks.onVoiceMoved?.(event.channelId);
      }
    });
    this.stomp.subscribe("/user/queue/call.signal", (raw) => {
      this.hooks.onCallSignal(JSON.parse(raw) as IncomingCallSignal);
    });
    this.stomp.subscribe("/user/queue/voice.invite", (raw) => {
      this.hooks.onVoiceInvite?.(JSON.parse(raw) as IncomingVoiceInvite);
    });
    // Ownership-transfer lifecycle: the runtime toasts on a received accept; the
    // pending banner itself rides the refetch (the reaction to EVERY type is the same).
    this.stomp.subscribe("/user/queue/ownership", (raw) => {
      this.hooks.onOwnershipEvent?.(JSON.parse(raw) as OwnershipEvent);
      this.ownershipRefresh.request();
    });
    // Social layer: every event is a REFRESH trigger (oak reacts to relationship
    // pushes with a plain refetch — no per-type branching). CLOSED is additionally
    // forgotten locally so the UI drops the row even if the refresh is slow/fails;
    // CREATED is merged from the push payload IMMEDIATELY — waiting for the
    // refetch round-trip would lose the first message of a re-created DM
    // (close DM → Message again: the sender posts right after the 200).
    this.stomp.subscribe("/user/queue/relationships", () => {
      this.socialRefresh.request();
    });
    this.stomp.subscribe("/user/queue/dm.channels", (raw) => {
      const event = JSON.parse(raw) as DmChannelEvent;
      if (event.type === "CLOSED") {
        this.forgetDm(event.channelId);
      } else if (event.type === "CREATED") {
        this.socialStore.mergeDm({
          id: event.channelId,
          type: event.channelType,
          name: event.name,
          ownerId: event.ownerId,
          participants: event.participants,
          lastMessageId: null,
          lastMessageAt: null,
          lastMessagePreview: null,
          lastMessageAuthorName: null,
        });
        this.syncDmSubscriptions();
      }
      this.socialRefresh.request();
    });
    // Member/role changes arrive as contentless pings — refetch both snapshots.
    this.stomp.subscribe("/topic/members", () => {
      this.memberRefresh.request();
      // Role ASSIGNMENT rides /topic/members too, and a mask change re-filters
      // the viewer's channel list — without the refetch the client keeps
      // rendering channels it can no longer see.
      void this.refetchChannels();
    });
    this.stomp.subscribe("/topic/roles", () => {
      this.memberRefresh.request();
      // A role edit changes every holder's effective mask, and GET /api/channels
      // is VIEWER-FILTERED — the list must be re-taken or a revoked VIEW/READ
      // leaves a dead-clickable channel behind (live report: entering it fails
      // with a READ_MESSAGE_HISTORY 403).
      void this.refetchChannels();
    });
    this.stomp.subscribe("/topic/emojis", () => {
      // Any catalog mutation pings here (bare timestamp) — the whole catalog is
      // small, refetch beats event-merging.
      this.emojiRefresh.request();
    });
    this.stomp.subscribe("/topic/stickers", () => {
      // The sticker catalog's own ping (bare timestamp) — same refetch stance.
      this.stickerRefresh.request();
    });
    this.stomp.subscribe("/topic/invites", () => {
      // Any invite mutation (mint, expire, TTL change — and a REGISTRATION claiming
      // a link, which is why the subscription lives here rather than in the section:
      // a spent link drops out of an OPEN settings screen live). The refetch quietly
      // no-ops for sessions without MANAGE_MEMBERS (403 in doRefreshInvites).
      this.invitesRefresh.request();
    });
    this.stomp.subscribe("/user/queue/member.kick", (raw) => {
      const event = JSON.parse(raw) as MemberKickEvent;
      log.warn("session", `${event.banned ? "banned" : "kicked"} by ${event.by} — tearing down`);
      this.hooks.onMemberKicked(event);
    });
    this.stomp.subscribe("/topic/server", (raw) => {
      const profile = JSON.parse(raw) as ServerProfile;
      this.serverProfile = profile;
      void this.directory.update(this.recordId, { cachedServerName: profile.name, cachedServerAvatarKey: profile.avatarKey });
    });
    this.stomp.subscribe("/topic/channels", (raw) => {
      const channel = JSON.parse(raw) as Channel;
      if (this.channelStore.applyCreated(channel)) {
        this.syncChannelSubscriptions();
        log.info("channels", `created #${channel.id} "${channel.name}" (${channel.type})`);
      }
    });
    this.stomp.subscribe("/topic/channels.deleted", (raw) => {
      const channelId = JSON.parse(raw) as number;
      log.info("channels", `deleted #${channelId}`);
      this.forgetChannel(channelId);
    });
    this.stomp.subscribe("/topic/channels.changed", () => {
      // Rename and permission-override edits arrive as a CONTENTLESS ping — the only
      // correct reaction is a diff-refetch (oak's refetchChannelsTask, not a reload).
      void this.refetchChannels();
    });
  }

  /** Subscribe the message-topic family of every TEXT channel (subscribe-all, VOICE excluded). */
  private syncChannelSubscriptions(): void {
    for (const channel of this.channelStore.getSnapshot()) {
      if (channel.type === "TEXT") {
        this.ensureChannelTopicFamily(channel.id);
      }
    }
  }

  /** Same for DMs — the topic family is IDENTICAL, the server gates it by participation. */
  private syncDmSubscriptions(): void {
    for (const dm of this.socialStore.getSnapshot().dms) {
      this.ensureChannelTopicFamily(dm.id);
    }
  }

  private ensureChannelTopicFamily(channelId: number): void {
    if (this.subscribedChannelIds.has(channelId)) {
      return;
    }
    this.subscribedChannelIds.add(channelId);
    const destination = `/topic/channel.${channelId}`;
    this.stomp.subscribe(destination, (raw) => {
      const message = JSON.parse(raw) as Message;
      const inserted = this.messageStore.applyLive(message);
      // Rows dropped because the channel history was NEVER LOADED still count:
      // the unread badge, the toast and the DM preview must fire for a fresh DM
      // or a never-opened channel. "Dropped + loaded" stays silent — that is
      // the sender's own REST echo arriving over STOMP.
      if (inserted || !this.messageStore.isLoaded(message.channelId)) {
        this.hooks.onLiveMessage(message);
      }
    });
    this.stomp.subscribe(`${destination}.edited`, (raw) => {
      const edited = JSON.parse(raw) as Message;
      this.messageStore.applyEdited(edited);
      // Pin/unpin ride the same .edited push. Fed DIRECTLY here, not via applyEdited's
      // return: an old pin usually lives OUTSIDE the loaded window and applyEdited
      // would return false for it — the pin card must never go stale over that.
      this.pinnedStore.applyFromMessage(edited);
    });
    this.stomp.subscribe(`${destination}.deleted`, (raw) => {
      this.messageStore.applyDeleted(channelId, JSON.parse(raw) as number);
    });
    this.stomp.subscribe(`${destination}.reactions`, (raw) => {
      const event = JSON.parse(raw) as ReactionEvent;
      this.messageStore.applyReactions(channelId, event.messageId, event.reactions);
    });
    this.stomp.subscribe(`${destination}.discussions`, (raw) => {
      const event = JSON.parse(raw) as DiscussionEvent;
      this.discussionsStore.applyEvent(event);
      this.hooks.onDiscussionEvent?.(event);
    });
    // NOTE: the mention notification for NON-open threads rides the ACTIVITY event above
    // (it carries the posted message) — only clients holding the thread's own family (the
    // open view, via onDiscussionLiveMessage) would otherwise see the message at all.
  }

  /**
   * The OPEN discussion's own topic family — a SEPARATE subscribe (not the channel family):
   * handlers write into messageStore but NEVER fire {@link SessionHooks.onLiveMessage}, so
   * thread messages bump no unread badge and update no DM preview (the structural fix for
   * the discussion leak). Mentions are the deliberate exception: the base-topic handler
   * fires {@link SessionHooks.onDiscussionLiveMessage}, whose runtime side runs mention
   * detection ONLY (a plain thread message stays silent; an @ping toasts and rings).
   * Idempotent per discussion id (the wire SUBSCRIBE itself is deduplicated by StompClient).
   */
  private ensureDiscussionTopicFamily(discussionId: number): void {
    if (this.subscribedDiscussionIds.has(discussionId)) {
      return;
    }
    this.subscribedDiscussionIds.add(discussionId);
    const destination = `/topic/channel.${discussionId}`;
    this.stomp.subscribe(destination, (raw) => {
      const message = JSON.parse(raw) as Message;
      this.messageStore.applyLive(message);
      this.hooks.onDiscussionLiveMessage?.(message);
    });
    this.stomp.subscribe(`${destination}.edited`, (raw) => {
      const edited = JSON.parse(raw) as Message;
      this.messageStore.applyEdited(edited);
      this.pinnedStore.applyFromMessage(edited);
    });
    this.stomp.subscribe(`${destination}.deleted`, (raw) => {
      this.messageStore.applyDeleted(discussionId, JSON.parse(raw) as number);
    });
    this.stomp.subscribe(`${destination}.reactions`, (raw) => {
      const event = JSON.parse(raw) as ReactionEvent;
      this.messageStore.applyReactions(discussionId, event.messageId, event.reactions);
    });
  }

  private async refetchChannels(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      this.channelStore.applySnapshot(await this.rest.getChannels());
      this.syncChannelSubscriptions();
      this.hooks.onChannelsChanged();
      // Override edits arrive as the same contentless ping — the viewer's gating
      // bits may have flipped with them (full live role-tracking is M7).
      void this.refreshPermissions();
    } catch (error) {
      log.warn("session", `channel refetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A WS gap swallowed every /topic push the server sent during it — nothing
   * arrives retroactively. On every REconnect re-take the same snapshot set
   * start() takes, then heal every loaded channel's tail: the refetched newest
   * page merges by id, and the messages that were actually missed fire the
   * live accounting (unread/mention/preview) exactly as if they had arrived
   * live. Everything dedups by id, so overlaps with pushes that DID make it
   * through are free.
   */
  private async resyncAfterReconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    log.info("session", "STOMP reconnected — resyncing what the gap missed");
    // Presence keeps its snapshot+delta-buffer discipline (see start()).
    this.rosterStore.beginPresenceSnapshot();
    void this.rest.getPresence()
      .then((presence) => {
        if (!this.disposed) {
          this.rosterStore.setPresence(presence);
        }
      })
      .catch((error: unknown) => {
        log.warn("session", `presence resync failed: ${error instanceof Error ? error.message : String(error)}`);
        this.rosterStore.abortPresenceSnapshot(); // unbuffer the deltas onto current state
      });
    void this.rest.getVoiceMembers()
      .then((voiceMembers) => {
        if (!this.disposed) {
          this.rosterStore.setVoiceMembers(voiceMembers);
        }
      })
      .catch((error: unknown) => {
        log.warn("session", `voice members resync failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    this.socialRefresh.request();
    this.memberRefresh.request();
    this.emojiRefresh.request();
    this.stickerRefresh.request();
    this.invitesRefresh.request();
    this.ownershipRefresh.request();
    void this.refetchChannels();
    // Read states BEFORE the tail heal: applySnapshot REPLACES per-channel
    // state, so a snapshot landing after the heals would erase their bumps.
    try {
      this.readStateStore.applySnapshot(await this.rest.getReadStates());
    } catch (error: unknown) {
      log.warn("session", `read states resync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Pin/unpin pushes missed over the gap would leave the pin card stale — refetch
    // every fetched pin list (a handful of channels at most, one light GET each).
    for (const channelId of this.pinnedStore.loadedChannelIds()) {
      if (this.disposed) {
        return;
      }
      try {
        this.pinnedStore.applySnapshot(channelId, await this.rest.getPinnedMessages(channelId));
      } catch (error: unknown) {
        log.warn("session", `pins resync failed for #${channelId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Discussions: the mine list and the tracked rows went stale over the gap the same way.
    try {
      this.discussionsStore.applyMineSnapshot(await this.rest.getMyDiscussions());
    } catch (error: unknown) {
      log.warn("session", `discussions resync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The OPEN discussion's topic families live on the new socket — re-subscribe. The guard
    // set SURVIVED the socket loss (it only tracks our bookkeeping), so it must be cleared
    // first or the early-return would skip every re-subscribe.
    const openDiscussionIds = [...this.subscribedDiscussionIds];
    this.subscribedDiscussionIds.clear();
    for (const discussionId of openDiscussionIds) {
      this.ensureDiscussionTopicFamily(discussionId);
    }
    await this.resyncMessageTails();
  }

  /** Sequential on purpose: a reconnect after a long gap can hold many loaded
   *  channels, and a burst of parallel history fetches would stampede the server. Discussion
   *  channels heal SILENTLY: mergeTail without the live accounting (thread unread must never
   *  feed the parent's badge or raise a toast). */
  private async resyncMessageTails(): Promise<void> {
    for (const channelId of this.messageStore.loadedChannelIds()) {
      if (this.disposed) {
        return;
      }
      if (this.subscribedDiscussionIds.has(channelId)) {
        try {
          const threadPage = await this.rest.getMessages(channelId, undefined, RESYNC_TAIL_LIMIT);
          if (!this.disposed) {
            this.messageStore.mergeTail(channelId, threadPage);
          }
        } catch (error: unknown) {
          log.warn("session", `discussion #${channelId} tail resync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      try {
        const page = await this.rest.getMessages(channelId, undefined, RESYNC_TAIL_LIMIT);
        if (this.disposed) {
          return;
        }
        const fresh = this.messageStore.mergeTail(channelId, page);
        for (const message of fresh) {
          this.hooks.onLiveMessage(message);
        }
      } catch (error: unknown) {
        log.warn("session", `channel #${channelId} tail resync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!this.disposed) {
      log.info("session", "reconnect gap heal complete");
    }
  }

  private async refreshPermissions(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      this.permissionStore.applyMy(await this.rest.getMyPermissions());
      const cachedChannelIds = [...this.permissionStore.getSnapshot().channels.keys()];
      for (const channelId of cachedChannelIds) {
        this.permissionStore.applyChannel(channelId, await this.rest.getChannelMyPermissions(channelId));
      }
    } catch (error) {
      log.warn("session", `permission refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
