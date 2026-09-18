import { log } from "../../logging";
import { RestClient } from "../../core/rest";
import { StompClient } from "../../core/stomp";
import type {
  CallIceCandidate,
  CallSignalType,
  Channel,
  DmChannel,
  DmChannelEvent,
  IncomingCallSignal,
  MemberKickEvent,
  Message,
  PresenceEvent,
  ReactionEvent,
  Relationship,
  Role,
  ServerProfile,
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
import { ReadStateStore } from "../stores/ReadStateStore";
import { RosterStore } from "../stores/RosterStore";
import { SocialStore } from "../stores/SocialStore";
import { VoiceControlStore } from "../stores/VoiceControlStore";
import { CoalescingRefresher } from "../lib/refresher";
import { AttachmentCache } from "../../media/attachment-cache";
import { PlaybackService } from "../../media/playback";
import { generateVideoPreview } from "../../media/video-thumbnail";
import { isVideoFile } from "../logic/attachment-layout";
import { sanitizeSlotFileName } from "../logic/ascii-name";
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
  /** /user/queue/voice.control type=KICKED — the runtime tears the voice session down. */
  onVoiceKicked(byUsername: string): void;
  /** A relayed 1:1 call signal (RING/ACCEPT/OFFER/ICE/…) — the runtime owns the call machine. */
  onCallSignal(signal: IncomingCallSignal): void;
  /** A DM vanished (closed everywhere or left by me) — the runtime re-homes the open chat. */
  onDmClosed(channelId: number): void;
  /** /user/queue/member.kick — the SERVER removed me: the runtime tears the session down. */
  onMemberKicked(event: MemberKickEvent): void;
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

  private readonly directory: ConnectionDirectory;
  private readonly hooks: SessionHooks;
  private readonly tokenStorage: RecordTokenStorage;
  private readonly subscribedChannelIds = new Set<number>();
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
    });
    this.stomp = new StompClient({
      url: toWsUrl(record?.hostUrl ?? ""),
      getAccessToken: () => this.tokenStorage.load()?.token ?? "",
      handlers: {
        onLost: (reason) => {
          log.warn("session", `STOMP lost: ${reason} (auto-reconnecting)`);
          this.hooks.onStompState("lost");
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
    this.stomp.disconnect();
  }

  isDisposed(): boolean {
    return this.disposed;
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

  async sendMessage(channelId: number, content: string, replyToId?: number): Promise<void> {
    // One key per composer submission: a network retry of THIS send reuses it,
    // and the server returns the original message instead of a duplicate.
    const created = await this.rest.sendMessage(channelId, {
      content,
      replyToId: replyToId ?? null,
      idempotencyKey: crypto.randomUUID(),
    });
    this.messageStore.applyLive(created); // the STOMP echo dedups against this id
  }

  /**
   * Upload a batch of files and send the message carrying them: per file —
   * mint a slot, PUT the bytes; videos additionally get a client-generated
   * JPEG preview (seek+canvas) uploaded as its own object. A failed preview
   * never blocks the send.
   */
  async sendMessageWithFiles(channelId: number, files: readonly File[], content: string | null, replyToId?: number): Promise<void> {
    const refs: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null }[] = [];
    for (const file of files) {
      // The slot name feeds only the object KEY (the server 400s on non-ASCII);
      // the ORIGINAL name stays on the message as the display fileName.
      const slot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(file.name));
      await this.rest.uploadBytes(slot.uploadUrl, await file.arrayBuffer(), file.type || "application/octet-stream");
      const reference: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null }
        = { key: slot.key, fileName: file.name, thumbnailKey: null, durationMillis: null };
      if (isVideoFile(file.name)) {
        const preview = await generateVideoPreview(file);
        if (preview !== null) {
          const thumbSlot = await this.rest.requestAttachmentUpload(sanitizeSlotFileName(`${file.name}-preview.jpg`));
          await this.rest.uploadBytes(thumbSlot.uploadUrl, await preview.jpegBlob.arrayBuffer(), "image/jpeg");
          reference.thumbnailKey = thumbSlot.key;
          reference.durationMillis = preview.durationMillis;
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
    remainingAttachments?: readonly { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null }[]): Promise<void> {
    const edited = await this.rest.editMessage(channelId, messageId, remainingAttachments === undefined
      ? { content }
      : {
        content,
        attachments: remainingAttachments.map((reference) => ({
          key: reference.key,
          fileName: reference.fileName,
          thumbnailKey: reference.thumbnailKey,
          durationMillis: reference.durationMillis,
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

  async createChannel(request: { name: string; type: "TEXT" | "VOICE" }): Promise<Channel> {
    const channel = await this.rest.createChannel(request);
    if (this.channelStore.applyCreated(channel)) {
      this.syncChannelSubscriptions(); // subscribe the new channel's topics now
    }
    return channel;
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

  async kickMember(userId: number): Promise<void> {
    await this.rest.kickMember(userId);
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
      this.rosterStore.updateUser(user);
      this.socialStore.applyUserRename(user.username, user.displayName ?? user.username);
    });
    this.stomp.subscribe("/topic/voice", (raw) => {
      const event = JSON.parse(raw) as VoiceMemberEvent;
      this.rosterStore.applyVoiceEvent(event);
      if (event.status === "LEFT") {
        // Their rows vanish; moderator marks survive server-side and re-publish on re-entry.
        this.voiceControlStore.clearUser(event.username);
      }
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
        this.hooks.onVoiceKicked(event.byUsername);
      }
    });
    this.stomp.subscribe("/user/queue/call.signal", (raw) => {
      this.hooks.onCallSignal(JSON.parse(raw) as IncomingCallSignal);
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
    });
    this.stomp.subscribe("/topic/roles", () => {
      this.memberRefresh.request();
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
      this.messageStore.applyEdited(JSON.parse(raw) as Message);
    });
    this.stomp.subscribe(`${destination}.deleted`, (raw) => {
      this.messageStore.applyDeleted(channelId, JSON.parse(raw) as number);
    });
    this.stomp.subscribe(`${destination}.reactions`, (raw) => {
      const event = JSON.parse(raw) as ReactionEvent;
      this.messageStore.applyReactions(channelId, event.messageId, event.reactions);
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
    void this.refetchChannels();
    // Read states BEFORE the tail heal: applySnapshot REPLACES per-channel
    // state, so a snapshot landing after the heals would erase their bumps.
    try {
      this.readStateStore.applySnapshot(await this.rest.getReadStates());
    } catch (error: unknown) {
      log.warn("session", `read states resync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.resyncMessageTails();
  }

  /** Sequential on purpose: a reconnect after a long gap can hold many loaded
   *  channels, and a burst of parallel history fetches would stampede the server. */
  private async resyncMessageTails(): Promise<void> {
    for (const channelId of this.messageStore.loadedChannelIds()) {
      if (this.disposed) {
        return;
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
