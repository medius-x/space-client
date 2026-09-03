import { log } from "../../logging";
import { RestClient } from "../../core/rest";
import { StompClient } from "../../core/stomp";
import type { Channel, Message, PresenceEvent, ServerProfile, VoiceMemberEvent } from "../../types";
import { ChannelStore } from "../stores/ChannelStore";
import { MessageStore } from "../stores/MessageStore";
import { PermissionStore } from "../stores/PermissionStore";
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
    const [channels, users, presence, voiceMembers, profile, myPermissions] = await Promise.all([
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

  async sendMessage(channelId: number, content: string): Promise<void> {
    const created = await this.rest.sendMessage(channelId, { content });
    this.messageStore.applyLive(created); // the STOMP echo dedups against this id
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

  /** Subscribe the message topic of every TEXT channel (subscribe-all, VOICE excluded). */
  private syncChannelSubscriptions(): void {
    for (const channel of this.channelStore.getSnapshot()) {
      if (channel.type !== "TEXT" || this.subscribedChannelIds.has(channel.id)) {
        continue;
      }
      this.subscribedChannelIds.add(channel.id);
      this.stomp.subscribe(`/topic/channel.${channel.id}`, (raw) => {
        this.messageStore.applyLive(JSON.parse(raw) as Message);
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
