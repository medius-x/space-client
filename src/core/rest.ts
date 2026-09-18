import type {
  AttachmentLink,
  AttachmentUploadSlot,
  AuthTokens,
  Channel,
  CallConfig,
  ChannelMyPermissions,
  ChannelOverride,
  ChannelReadState,
  ChannelType,
  ChannelUserOverride,
  DmChannel,
  ForwardMessageRequest,
  Message,
  MyPermissions,
  PermissionCatalogEntry,
  ReactionSummary,
  Relationship,
  Role,
  RoomInfo,
  SearchMessagesResult,
  ServerMember,
  ServerProfile,
  StorageGcRun,
  StoragePolicy,
  StorageStatus,
  UserRenamedResponse,
  UserResponse,
  UserSummary,
} from "../types";
import type { TokenStorage } from "./auth";
import { log } from "../logging";

/** POST /api/auth/login|refresh response shape (field names are the wire contract). */
interface AuthResponse {
  token: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface RestClientOptions {
  baseUrl: string;
  tokenStorage: TokenStorage;
  /** Seam for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Fires when the refresh family is dead — the app returns to the login screen. */
  onSessionExpired?: () => void;
  /** Network-failure retry backoff for IDEMPOTENT calls (GET/PUT/DELETE and
   *  idempotency-keyed posts); tests inject zeros. Default [500, 1500]. */
  retryDelaysMs?: readonly number[];
}

/** A JSON call must fail fast into the retry ladder — a hung request (dead
 *  socket, stalled middleware) pends forever otherwise. Not applied to the
 *  byte endpoints (uploadBytes/downloadBytes): large bodies legitimately take
 *  minutes. */
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/**
 * REST client for the OAK server: Bearer auth on every call, silent token refresh.
 *
 * The server ROTATES the refresh family and revokes the whole family on refresh-token
 * REUSE — two parallel refreshes with the same token would log the user out. Hence the
 * single-flight promise below: N concurrent 401s share exactly one POST /api/auth/refresh.
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly tokenStorage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly onSessionExpired?: () => void;
  private readonly retryDelays: readonly number[];
  private refreshInFlight: Promise<void> | null = null;

  constructor(options: RestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.tokenStorage = options.tokenStorage;
    // BIND: a detached window.fetch throws "Illegal invocation" in Chromium — the
    // default must keep the global as its receiver. Node's fetch tolerates it, which
    // is exactly why the fakes-injected unit tests never saw this.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  getTokens(): AuthTokens | null {
    return this.tokenStorage.load();
  }

  async login(username: string, password: string): Promise<void> {
    const auth = await this.request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      authenticated: false,
    });
    await this.saveTokens(auth, null);
    log.info("rest", `logged in (token expires in ${auth.expiresIn}s)`);
  }

  async register(username: string, password: string): Promise<void> {
    await this.request<unknown>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      authenticated: false,
    });
    // register returns no tokens — log straight in (spike UX)
    await this.login(username, password);
  }

  async getChannels(): Promise<Channel[]> {
    return this.request<Channel[]>("/api/channels", { method: "GET" });
  }

  async getUsers(): Promise<UserSummary[]> {
    return this.request<UserSummary[]>("/api/users", { method: "GET" });
  }

  /** Online usernames (sorted). */
  async getPresence(): Promise<string[]> {
    return this.request<string[]>("/api/presence", { method: "GET" });
  }

  /** Voice-membership snapshot: channelId → usernames. */
  async getVoiceMembers(): Promise<{ channelId: number; usernames: string[] }[]> {
    return this.request<{ channelId: number; usernames: string[] }[]>("/api/voice/members", { method: "GET" });
  }

  async getRoom(channelId: number): Promise<RoomInfo> {
    return this.request<RoomInfo>(`/api/channels/${channelId}/room`, { method: "GET" });
  }

  /** ICE/TURN servers for 1:1 peer connections (STUN + Coturn relay fallback). */
  async getCallConfig(): Promise<CallConfig> {
    return this.request<CallConfig>("/api/call/config", { method: "GET" });
  }

  // ---------------------------------------------------------------------------
  // Chat + channels + server profile (M1)
  // ---------------------------------------------------------------------------

  /** History page, OLDEST FIRST (the server reverses its DESC page query). Cursor flavours
   *  (at most one, server-validated): `beforeId` — strictly older (back-fill); `aroundId` —
   *  a window centered on the message (the search-result jump); `afterId` — strictly newer
   *  (pagination away from an around window). */
  async getMessages(channelId: number, beforeId?: number, limit?: number,
    cursor?: { aroundId?: number; afterId?: number }): Promise<Message[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    if (beforeId !== undefined) {
      params.set("beforeId", String(beforeId));
    }
    if (cursor?.aroundId !== undefined) {
      params.set("aroundId", String(cursor.aroundId));
    }
    if (cursor?.afterId !== undefined) {
      params.set("afterId", String(cursor.afterId));
    }
    const query = params.toString();
    return this.request<Message[]>(`/api/channels/${channelId}/messages${query ? `?${query}` : ""}`, { method: "GET" });
  }

  /** Message search (Discord-style substring match), newest first. `channelId` scopes to one
   *  channel (a DM works); omitted — the whole server (the server never returns DMs there).
   *  `q` and `author` are both optional, at least one required server-side; `beforeId` pages
   *  older; `total` is the cursor-independent hit count. */
  async searchMessages(request: {
    q?: string | null;
    channelId?: number | null;
    author?: string | null;
    beforeId?: number;
    limit?: number;
  }): Promise<SearchMessagesResult> {
    const params = new URLSearchParams();
    if (request.q != null && request.q !== "") {
      params.set("q", request.q);
    }
    if (request.channelId != null) {
      params.set("channelId", String(request.channelId));
    }
    if (request.author != null && request.author !== "") {
      params.set("author", request.author);
    }
    if (request.beforeId !== undefined) {
      params.set("beforeId", String(request.beforeId));
    }
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const query = params.toString();
    return this.request<SearchMessagesResult>(`/api/search/messages${query ? `?${query}` : ""}`, { method: "GET" });
  }

  /** 201 + the created message; the STOMP echo of the same id arrives too — dedup upstream.
   *  The idempotency key makes network-level retries safe: a retry after a LOST
   *  RESPONSE reuses the key and the server returns the ORIGINAL message instead
   *  of duplicating it. */
  async sendMessage(channelId: number, request: {
    content: string | null;
    attachments?: { key: string; fileName: string; thumbnailKey?: string | null; durationMillis?: number | null }[];
    replyToId?: number | null;
    idempotencyKey?: string;
  }): Promise<Message> {
    return this.request<Message>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(request),
      idempotencyKey: request.idempotencyKey,
    });
  }

  /** PATCH returns the edited message; the .edited topic echo dedups by id upstream.
   *  The edit body is oak's EditMessageRequest: `attachments` ABSENT/null = leave
   *  the message's attachments untouched (the plain text edit); a list = replace
   *  with exactly these — the server validates it is a subset of the currently
   *  attached keys. Content may be blank while an attachment remains. */
  async editMessage(channelId: number, messageId: number, request: {
    content: string;
    attachments?: { key: string; fileName: string; thumbnailKey: string | null; durationMillis: number | null }[] | null;
  }): Promise<Message> {
    return this.request<Message>(`/api/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  async deleteMessage(channelId: number, messageId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
  }

  /** Both reaction calls return the message's full reaction snapshot (200). */
  async addReaction(channelId: number, messageId: number, slug: string): Promise<ReactionSummary[]> {
    return this.request<ReactionSummary[]>(`/api/channels/${channelId}/messages/${messageId}/reactions/${slug}`, {
      method: "PUT",
    });
  }

  async removeReaction(channelId: number, messageId: number, slug: string): Promise<ReactionSummary[]> {
    return this.request<ReactionSummary[]>(`/api/channels/${channelId}/messages/${messageId}/reactions/${slug}`, {
      method: "DELETE",
    });
  }

  async forwardMessage(targetChannelId: number, request: ForwardMessageRequest): Promise<Message> {
    return this.request<Message>(`/api/channels/${targetChannelId}/messages/forward`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getReadStates(): Promise<ChannelReadState[]> {
    return this.request<ChannelReadState[]>("/api/read-states", { method: "GET" });
  }

  /** null lastReadMessageId = "mark everything currently there as read" (empty body). */
  async ackChannelRead(channelId: number, lastReadMessageId: number | null): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}/read`, {
      method: "POST",
      body: lastReadMessageId === null ? undefined : JSON.stringify({ lastReadMessageId }),
    });
  }

  // ---------------------------------------------------------------------------
  // Attachments & avatars (M3)
  // ---------------------------------------------------------------------------

  /** Phase 1 of an upload: mint a key + presigned PUT slot for the bytes. */
  async requestAttachmentUpload(fileName: string): Promise<AttachmentUploadSlot> {
    return this.request<AttachmentUploadSlot>("/api/attachments", {
      method: "POST",
      body: JSON.stringify({ fileName }),
    });
  }

  /**
   * Phase 2: PUT the bytes straight to MinIO. NO auth header (the signature lives
   * in the query string); Content-Type inferred by the caller, like the Java client.
   */
  async uploadBytes(presignedUrl: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    const response = await this.fetchImpl(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!response.ok) {
      throw new ApiError(response.status, `MinIO upload failed: HTTP ${response.status}`);
    }
  }

  /** Raw GET of a presigned URL (lightbox download, cross-instance re-upload). */
  async downloadBytes(url: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(url, { method: "GET" });
    if (!response.ok) {
      throw new ApiError(response.status, `download failed: HTTP ${response.status}`);
    }
    return await response.arrayBuffer();
  }

  /** Re-mint a presigned GET for a key we already hold; null when the object is gone. */
  async freshAttachmentLink(key: string): Promise<string | null> {
    try {
      const link = await this.request<AttachmentLink>(`/api/attachments/link?key=${encodeURIComponent(key)}`, {
        method: "GET",
      });
      return link.url;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async requestAvatarUpload(fileName: string): Promise<AttachmentUploadSlot> {
    return this.request<AttachmentUploadSlot>("/api/users/me/avatar", {
      method: "POST",
      body: JSON.stringify({ fileName }),
    });
  }

  async requestAvatarOriginalUpload(fileName: string): Promise<AttachmentUploadSlot> {
    return this.request<AttachmentUploadSlot>("/api/users/me/avatar/original", {
      method: "POST",
      body: JSON.stringify({ fileName }),
    });
  }

  /** originalKey null = re-crop (keep the stored original, only the crop changed). */
  async confirmAvatar(avatarKey: string, originalKey: string | null): Promise<UserResponse> {
    return this.request<UserResponse>("/api/users/me/avatar/confirm", {
      method: "POST",
      body: JSON.stringify({ avatarKey, originalKey }),
    });
  }

  async removeAvatar(): Promise<UserResponse> {
    return this.request<UserResponse>("/api/users/me/avatar", { method: "DELETE" });
  }

  /** Lazy presigned GET of the stored pre-crop original; null when none exists. */
  async getAvatarOriginalUrl(): Promise<string | null> {
    try {
      const link = await this.request<AttachmentLink>("/api/users/me/avatar/original", { method: "GET" });
      return link.url;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- server icon (instance avatar, MANAGE_SERVER; mirrors the user flow) ---

  async requestServerAvatarUpload(fileName: string): Promise<AttachmentUploadSlot> {
    return this.request<AttachmentUploadSlot>("/api/server/avatar", {
      method: "POST",
      body: JSON.stringify({ fileName }),
    });
  }

  async requestServerAvatarOriginalUpload(fileName: string): Promise<AttachmentUploadSlot> {
    return this.request<AttachmentUploadSlot>("/api/server/avatar/original", {
      method: "POST",
      body: JSON.stringify({ fileName }),
    });
  }

  /** Binds the freshly uploaded icon objects; /topic/server pushes the new profile. */
  async confirmServerAvatar(avatarKey: string, originalKey: string | null): Promise<ServerProfile> {
    return this.request<ServerProfile>("/api/server/avatar/confirm", {
      method: "POST",
      body: JSON.stringify({ avatarKey, originalKey }),
    });
  }

  async removeServerAvatar(): Promise<ServerProfile> {
    return this.request<ServerProfile>("/api/server/avatar", { method: "DELETE" });
  }

  /** Lazy presigned GET of the server icon's pre-crop original; null on 404. */
  async getServerAvatarOriginalUrl(): Promise<string | null> {
    try {
      const link = await this.request<AttachmentLink>("/api/server/avatar/original", { method: "GET" });
      return link.url;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- storage GC ("Server" settings screen, MANAGE_STORAGE) ---

  async getStorageStatus(): Promise<StorageStatus> {
    return this.request<StorageStatus>("/api/server/storage", { method: "GET" });
  }

  async updateStorageSettings(policy: StoragePolicy): Promise<StorageStatus> {
    return this.request<StorageStatus>("/api/server/storage", {
      method: "PUT",
      body: JSON.stringify(policy),
    });
  }

  /** Fires one GC pass NOW; the run itself is background — poll getStorageStatus(). */
  async triggerStorageGc(): Promise<StorageGcRun> {
    return this.request<StorageGcRun>("/api/server/storage/run", { method: "POST" });
  }

  async createChannel(request: { name: string; type?: ChannelType | null }): Promise<Channel> {
    return this.request<Channel>("/api/channels", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  /** Rename is PATCH /name — the bare PATCH /{id} route belongs to group-DM rename. */
  async renameChannel(channelId: number, name: string): Promise<Channel> {
    return this.request<Channel>(`/api/channels/${channelId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async deleteChannel(channelId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}`, { method: "DELETE" });
  }

  async getServerProfile(): Promise<ServerProfile> {
    return this.request<ServerProfile>("/api/server", { method: "GET" });
  }

  /** Server-wide viewer permissions + OWNER flag (for UI gating). */
  async getMyPermissions(): Promise<MyPermissions> {
    return this.request<MyPermissions>("/api/users/me/permissions", { method: "GET" });
  }

  /** Override-aware SEND_MESSAGES / ATTACH_FILES on one channel — gates the composer. */
  async getChannelMyPermissions(channelId: number): Promise<ChannelMyPermissions> {
    return this.request<ChannelMyPermissions>(`/api/channels/${channelId}/permissions/me`, { method: "GET" });
  }

  // ---------------------------------------------------------------------------
  // Social layer: friends, blocks, DMs, member roster (M6)
  // ---------------------------------------------------------------------------

  /** The caller-view relationship list (direction already folded into the type). */
  async getRelationships(): Promise<Relationship[]> {
    return this.request<Relationship[]>("/api/users/me/relationships", { method: "GET" });
  }

  /** 201; mutual pending auto-accepts into FRIEND on the server. */
  async addFriend(username: string): Promise<Relationship> {
    return this.request<Relationship>("/api/users/me/friends", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  }

  async acceptFriend(userId: number): Promise<Relationship> {
    return this.request<Relationship>(`/api/users/me/friends/${userId}`, { method: "PUT" });
  }

  /** One endpoint for cancel/decline/unfriend — idempotent, 204. */
  async removeFriend(userId: number): Promise<void> {
    await this.request<unknown>(`/api/users/me/friends/${userId}`, { method: "DELETE" });
  }

  async blockUser(username: string): Promise<Relationship> {
    return this.request<Relationship>("/api/users/me/blocks", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  }

  async unblockUser(userId: number): Promise<void> {
    await this.request<unknown>(`/api/users/me/blocks/${userId}`, { method: "DELETE" });
  }

  /** The DM list — DM/GROUP_DM never appear in GET /api/channels. */
  async getDmChannels(): Promise<DmChannel[]> {
    return this.request<DmChannel[]>("/api/channels/dm", { method: "GET" });
  }

  /** Get-or-create a 1:1 DM — always 200, duplicates are impossible (dmKey unique). */
  async createDm(recipientId: number): Promise<DmChannel> {
    return this.request<DmChannel>("/api/channels/dm", {
      method: "POST",
      body: JSON.stringify({ recipientId }),
    });
  }

  /** participantIds 2..9 → the group ends up 3..10 including the creator. */
  async createGroupDm(participantIds: number[], name: string | null): Promise<DmChannel> {
    return this.request<DmChannel>("/api/channels/group-dm", {
      method: "POST",
      body: JSON.stringify({ participantIds, name }),
    });
  }

  /** Group rename — the BARE PATCH /api/channels/{id} route (server channels use /name). */
  async renameDm(channelId: number, name: string): Promise<DmChannel> {
    return this.request<DmChannel>(`/api/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async addDmParticipant(channelId: number, userId: number): Promise<DmChannel> {
    return this.request<DmChannel>(`/api/channels/${channelId}/participants`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  /** Self = leave; removing someone else = owner-only (checked server-side). */
  async removeDmParticipant(channelId: number, userId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}/participants/${userId}`, { method: "DELETE" });
  }

  async closeDm(channelId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/dm/${channelId}`, { method: "DELETE" });
  }

  async getMembers(): Promise<ServerMember[]> {
    return this.request<ServerMember[]>("/api/members", { method: "GET" });
  }

  async getRoles(): Promise<Role[]> {
    return this.request<Role[]>("/api/roles", { method: "GET" });
  }

  async kickMember(userId: number): Promise<void> {
    await this.request<unknown>(`/api/members/${userId}/kick`, { method: "POST" });
  }

  /** FULL replacement of the member's explicit role set (PUT). */
  async updateMemberRoles(userId: number, roleIds: number[]): Promise<ServerMember> {
    return this.request<ServerMember>(`/api/members/${userId}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    });
  }

  async banMember(userId: number): Promise<void> {
    await this.request<unknown>(`/api/members/${userId}/ban`, { method: "POST" });
  }

  async unbanMember(userId: number): Promise<void> {
    await this.request<unknown>(`/api/members/${userId}/ban`, { method: "DELETE" });
  }

  /** Sets the member's NICKNAME (the display name; someone else needs
   *  MANAGE_NICKNAMES + hierarchy, yourself CHANGE_NICKNAME). 409 = taken. */
  async renameMember(userId: number, nickname: string): Promise<void> {
    await this.request<unknown>(`/api/members/${userId}/nickname`, {
      method: "PATCH",
      body: JSON.stringify({ nickname }),
    });
  }

  /** Resets the nickname to the member's login handle. */
  async resetMemberNickname(userId: number): Promise<void> {
    await this.request<unknown>(`/api/members/${userId}/nickname`, { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // RBAC editor (M7): role CRUD, channel overrides, account mutations
  // ---------------------------------------------------------------------------

  async getPermissionCatalog(): Promise<PermissionCatalogEntry[]> {
    return this.request<PermissionCatalogEntry[]>("/api/permissions", { method: "GET" });
  }

  /** 201; the server defaults mentionable/hoist to false, color to null. */
  async createRole(request: {
    name: string;
    permissions?: string[] | null;
    color?: number | null;
    mentionable?: boolean | null;
    hoist?: boolean | null;
  }): Promise<Role> {
    return this.request<Role>("/api/roles", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  /**
   * Partial PATCH: null fields keep their value, EXCEPT color — null RESETS it
   * (send the current color to keep it). @everyone edits permissions/mentionable
   * only; the OWNER role is 403.
   */
  async updateRole(roleId: number, request: {
    name?: string | null;
    permissions?: string[] | null;
    color?: number | null;
    mentionable?: boolean | null;
    hoist?: boolean | null;
  }): Promise<Role> {
    return this.request<Role>(`/api/roles/${roleId}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  async deleteRole(roleId: number): Promise<void> {
    await this.request<unknown>(`/api/roles/${roleId}`, { method: "DELETE" });
  }

  /** Custom roles only, top→bottom; the list may be partial (dense renumber). */
  async reorderRoles(roleIds: readonly number[]): Promise<void> {
    await this.request<unknown>("/api/roles/order", {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    });
  }

  async getChannelOverrides(channelId: number): Promise<ChannelOverride[]> {
    return this.request<ChannelOverride[]>(`/api/channels/${channelId}/overrides`, { method: "GET" });
  }

  /** Full replacement of both sets for one role (PUT). */
  async upsertChannelOverride(channelId: number, roleId: number, request: { allow: string[]; deny: string[] }): Promise<ChannelOverride> {
    return this.request<ChannelOverride>(`/api/channels/${channelId}/overrides/${roleId}`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async deleteChannelOverride(channelId: number, roleId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}/overrides/${roleId}`, { method: "DELETE" });
  }

  async getChannelUserOverrides(channelId: number): Promise<ChannelUserOverride[]> {
    return this.request<ChannelUserOverride[]>(`/api/channels/${channelId}/overrides/users`, { method: "GET" });
  }

  async upsertChannelUserOverride(channelId: number, userId: number, request: { allow: string[]; deny: string[] }): Promise<ChannelUserOverride> {
    return this.request<ChannelUserOverride>(`/api/channels/${channelId}/overrides/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async deleteChannelUserOverride(channelId: number, userId: number): Promise<void> {
    await this.request<unknown>(`/api/channels/${channelId}/overrides/users/${userId}`, { method: "DELETE" });
  }

  async getBannedMembers(): Promise<ServerMember[]> {
    return this.request<ServerMember[]>("/api/members/bans", { method: "GET" });
  }

  async renameServer(name: string): Promise<ServerProfile> {
    return this.request<ServerProfile>("/api/server", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  /** The response carries a FRESH token pair — the whole old family is revoked. */
  async changeUsername(username: string): Promise<UserRenamedResponse> {
    return this.request<UserRenamedResponse>("/api/users/me/username", {
      method: "PATCH",
      body: JSON.stringify({ username }),
    });
  }

  /** Rotates the refresh family too; the new pair is saved into this client's storage. */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const auth = await this.request<{ token: string; refreshToken: string; tokenType: string; expiresIn: number }>(
      "/api/users/me/password",
      {
        method: "POST",
        body: JSON.stringify({ oldPassword, newPassword }),
      },
    );
    const previous = this.tokenStorage.load();
    await this.tokenStorage.save({
      token: auth.token,
      refreshToken: auth.refreshToken,
      expiresAt: Date.now() + auth.expiresIn * 1000,
    }, previous);
    log.info("rest", "password changed — token family rotated");
  }

  logout(): void {
    this.tokenStorage.clear();
  }

  // ---------------------------------------------------------------------------

  private async saveTokens(auth: AuthResponse, previous: AuthTokens | null): Promise<void> {
    await this.tokenStorage.save({
      token: auth.token,
      refreshToken: auth.refreshToken,
      expiresAt: Date.now() + auth.expiresIn * 1000,
    }, previous);
  }

  private async refreshOnce(): Promise<void> {
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const tokens = this.tokenStorage.load();
    if (!tokens) {
      throw new ApiError(401, "No stored session");
    }
    // Timed out, but NEVER retried: the refresh token is single-use — repeating
    // a possibly-delivered refresh would reuse it and revoke the whole family.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      log.warn("rest", `refresh rejected (${response.status}) — session expired`);
      this.tokenStorage.clear();
      this.onSessionExpired?.();
      throw new ApiError(response.status, "Session expired");
    }
    const auth = (await response.json()) as AuthResponse;
    await this.saveTokens(auth, tokens);
    log.info("rest", "token refreshed");
  }

  private async request<T>(path: string, init: {
    method: string;
    body?: string;
    authenticated?: boolean;
    retried?: boolean;
    /** Present = the call is idempotent server-side, so a network-level retry
     *  (lost response) is safe. Message sends carry a generated key and the
     *  server returns the ORIGINAL message on a key collision. */
    idempotencyKey?: string;
  }): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tokens = this.tokenStorage.load();
    if (init.authenticated !== false && tokens) {
      headers.Authorization = `Bearer ${tokens.token}`;
    }
    const response = await this.fetchWithRetries(path, init, headers);

    if (response.status === 401 && init.authenticated !== false && !init.retried && tokens) {
      await this.refreshOnce();
      return this.request<T>(path, { ...init, retried: true });
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body && typeof body.message === "string") {
          message = body.message;
        }
      } catch {
        // non-JSON error body — keep the HTTP status line
      }
      throw new ApiError(response.status, message);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    // Spring answers void endpoints (kick/ban/unban/...) with 200 + an EMPTY
    // body — response.json() throws "Unexpected end of JSON input" on it (live
    // report: the ban landed, the badge arrived, the call still "failed").
    // Parse only when there is actually something to parse.
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  /**
   * The network-retry ladder. Only IDEMPOTENT calls may repeat — GET/PUT/DELETE
   * plus POSTs that carry an idempotency key the server dedups on: a request
   * whose response was lost MAY have been acted upon, and blindly repeating a
   * plain POST would duplicate the message/create. Server answers (any HTTP
   * status, including 5xx) are NOT retried — that is the server speaking, and
   * repeating a 500 could re-trigger side effects. Timeouts count as network
   * failures (no response).
   */
  private async fetchWithRetries(path: string, init: { method: string; body?: string; idempotencyKey?: string },
    headers: Record<string, string>): Promise<Response> {
    const retryable = init.method === "GET" || init.method === "PUT" || init.method === "DELETE"
      || init.idempotencyKey !== undefined;
    const attempts = retryable ? this.retryDelays.length + 1 : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelays[attempt - 2]));
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body,
          signal: controller.signal,
        });
      } catch (error: unknown) {
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        log.warn("rest", `${init.method} ${path} no response (attempt ${attempt}/${attempts}): ${reason}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
