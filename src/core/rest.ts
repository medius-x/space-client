import type { AuthTokens, Channel, ChannelMyPermissions, ChannelType, Message, MyPermissions, RoomInfo, ServerProfile, UserSummary } from "../types";
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
}

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
  private refreshInFlight: Promise<void> | null = null;

  constructor(options: RestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.tokenStorage = options.tokenStorage;
    // BIND: a detached window.fetch throws "Illegal invocation" in Chromium — the
    // default must keep the global as its receiver. Node's fetch tolerates it, which
    // is exactly why the fakes-injected unit tests never saw this.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
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

  // ---------------------------------------------------------------------------
  // Chat + channels + server profile (M1)
  // ---------------------------------------------------------------------------

  /** History page, OLDEST FIRST (the server reverses its DESC page query). */
  async getMessages(channelId: number, beforeId?: number, limit?: number): Promise<Message[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    if (beforeId !== undefined) {
      params.set("beforeId", String(beforeId));
    }
    const query = params.toString();
    return this.request<Message[]>(`/api/channels/${channelId}/messages${query ? `?${query}` : ""}`, { method: "GET" });
  }

  /** 201 + the created message; the STOMP echo of the same id arrives too — dedup upstream. */
  async sendMessage(channelId: number, request: {
    content: string | null;
    attachments?: { key: string; fileName: string; thumbnailKey?: string | null; durationMillis?: number | null }[];
    replyToId?: number | null;
  }): Promise<Message> {
    return this.request<Message>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(request),
    });
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
    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
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
  }): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tokens = this.tokenStorage.load();
    if (init.authenticated !== false && tokens) {
      headers.Authorization = `Bearer ${tokens.token}`;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
    });

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
    return (await response.json()) as T;
  }
}
