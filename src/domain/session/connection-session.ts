import { log } from "../../logging";
import { RestClient } from "../../core/rest";
import { StompClient } from "../../core/stomp";
import type { Channel, Message, PresenceEvent, ReactionEvent, ServerProfile, VoiceMemberEvent } from "../../types";
import { ChannelStore } from "../stores/ChannelStore";
import { MessageStore } from "../stores/MessageStore";
import { PermissionStore } from "../stores/PermissionStore";
import { ReadStateStore } from "../stores/ReadStateStore";
import { RosterStore } from "../stores/RosterStore";
import { ConnectionDirectory, RecordTokenStorage } from "./connection-record";

/** Fires into the app shell (runtime.ts) — the session never touches UI state itself. */
export interface SessionHooks {
  onSessionExpired(recordId: string): void;
  onStompState(state: "connecting" | "connected" | "lost"): void;
  /** After every (re)connect — the runtime re-sends /app/voice.join if a room is live. */
  onStompConnected(): void;
  /** A channel vanished (deleted or hidden) — the runtime re-homes the active chat/voice. */
  onChannelGone(channelId: number): void;
  /** After a diff-refetch applied (rename/override pings) — re-validate active channel. */
  onChannelsChanged(): void;
  /** A live message actually INSERTED into a loaded channel (echo-deduped). */
  onLiveMessage(message: Message): void;
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
  readonly permissionStore = new PermissionStore();
  readonly readStateStore = new ReadStateStore();

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
        onConnected: () => {
          this.hooks.onStompState("connected");
          this.hooks.onStompConnected();
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
    const [channels, users, presence, voiceMembers, profile, myPermissions, readStates] = await Promise.all([
      this.rest.getChannels(),
      this.rest.getUsers(),
      this.rest.getPresence(),
      this.rest.getVoiceMembers(),
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
    this.rosterStore.setPresence(presence);
    this.rosterStore.setVoiceMembers(voiceMembers);
    if (profile) {
      void this.directory.update(this.recordId, { cachedServerName: profile.name });
    }
    if (myPermissions) {
      this.permissionStore.applyMy(myPermissions);
    }
    if (readStates) {
      this.readStateStore.applySnapshot(readStates);
    }
    void this.directory.touch(this.recordId);

    this.hooks.onStompState("connecting");
    await this.stomp.connect();
    this.subscribeGlobalTopics();
    this.syncChannelSubscriptions();
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
    const created = await this.rest.sendMessage(channelId, { content, replyToId: replyToId ?? null });
    this.messageStore.applyLive(created); // the STOMP echo dedups against this id
  }

  async editMessage(channelId: number, messageId: number, content: string): Promise<void> {
    const edited = await this.rest.editMessage(channelId, messageId, { content });
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
  // STOMP topic wiring
  // ---------------------------------------------------------------------------

  private subscribeGlobalTopics(): void {
    this.stomp.subscribe("/topic/presence", (raw) => {
      this.rosterStore.applyPresenceEvent(JSON.parse(raw) as PresenceEvent);
    });
    this.stomp.subscribe("/topic/voice", (raw) => {
      const event = JSON.parse(raw) as VoiceMemberEvent;
      this.rosterStore.applyVoiceEvent(event);
      log.info("voice", `${event.username} ${event.status.toLowerCase()} channel #${event.channelId}`);
    });
    this.stomp.subscribe("/topic/server", (raw) => {
      const profile = JSON.parse(raw) as ServerProfile;
      void this.directory.update(this.recordId, { cachedServerName: profile.name });
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
      if (channel.type !== "TEXT" || this.subscribedChannelIds.has(channel.id)) {
        continue;
      }
      this.subscribedChannelIds.add(channel.id);
      const destination = `/topic/channel.${channel.id}`;
      this.stomp.subscribe(destination, (raw) => {
        const message = JSON.parse(raw) as Message;
        if (this.messageStore.applyLive(message)) {
          this.hooks.onLiveMessage(message);
        }
      });
      this.stomp.subscribe(`${destination}.edited`, (raw) => {
        this.messageStore.applyEdited(JSON.parse(raw) as Message);
      });
      this.stomp.subscribe(`${destination}.deleted`, (raw) => {
        this.messageStore.applyDeleted(channel.id, JSON.parse(raw) as number);
      });
      this.stomp.subscribe(`${destination}.reactions`, (raw) => {
        const event = JSON.parse(raw) as ReactionEvent;
        this.messageStore.applyReactions(channel.id, event.messageId, event.reactions);
      });
    }
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
