/** Wire + domain types shared across the spike. Field names are the JSON contract. */

export interface AuthTokens {
  token: string;
  refreshToken: string;
  /** Epoch ms when the access token expires (now + expiresIn*1000). */
  expiresAt: number;
}

export type ChannelType = "TEXT" | "VOICE" | "DM" | "GROUP_DM";

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  createdAt: string;
  locked: boolean;
}

export interface UserSummary {
  id: number;
  username: string;
  avatarKey: string | null;
  avatarUrl: string | null;
  /** The NICKNAME — the only name the UI shows (chat authors, roster, voice,
   *  call cards). `username` stays as the stable lookup key, never rendered. */
  displayName: string;
}

// ---------------------------------------------------------------------------
// Messages (GET/POST /api/channels/{id}/messages — MessageResponse verbatim)
// ---------------------------------------------------------------------------

/**
 * `url` is a presigned GET that the server RE-SIGNS on every fetch — it is never a
 * stable identity. `key` is. (Attachment rendering itself arrives in M3.)
 */
export interface Attachment {
  fileName: string;
  url: string;
  key: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  durationMillis: number | null;
}

/** M2 surface — carried verbatim so the wire type never needs re-touching. */
export interface MentionInfo {
  type: "USER" | "ROLE" | "EVERYONE" | "HERE";
  id: number | null;
  name: string;
  start: number;
  end: number;
}

export interface ReactionSummary {
  reaction: string;
  count: number;
  userIds: number[];
  usernames: string[];
}

export interface ReplyInfo {
  messageId: number;
  authorId: number;
  authorUsername: string;
  preview: string;
  createdAt: string;
  deleted: boolean;
  forward: ForwardInfo | null;
  reply: ReplyInfo | null; // null = depth-5 cutoff
}

export interface ForwardInfo {
  serverName: string;
  channelName: string;
  authorId: number;
  authorUsername: string;
  createdAt: string;
  trusted: boolean;
  reply: ReplyInfo | null;
}

export interface Message {
  id: number;
  channelId: number;
  authorId: number;
  authorUsername: string;
  /** NULL for attachment-only messages (the live server sends null, not ""). */
  content: string | null;
  /** ISO-8601 UTC string. */
  createdAt: string;
  attachments: Attachment[];
  mentions: MentionInfo[];
  editedAt: string | null;
  reactions: ReactionSummary[];
  reply: ReplyInfo | null;
  forward: ForwardInfo | null;
}

// ---------------------------------------------------------------------------
// Server profile (GET /api/server)
// ---------------------------------------------------------------------------

export interface ServerProfile {
  id: number;
  name: string;
  avatarKey: string | null;
  avatarUrl: string | null;
  connectionHost: string | null;
  connectionPort: number | null;
}

// ---------------------------------------------------------------------------
// M3: attachments and avatars (upload slots, fresh links, public user view)
// ---------------------------------------------------------------------------

/** POST /api/attachments (and the avatar slots) — a presigned PUT target + stable key. */
export interface AttachmentUploadSlot {
  key: string;
  uploadUrl: string;
}

/** GET /api/attachments/link?key=… — a re-minted presigned GET (404 → null on the client). */
export interface AttachmentLink {
  url: string;
}

/** The public user view (avatar confirm/remove responses, GET /api/users/me). */
export interface UserResponse {
  id: number;
  username: string;
  createdAt: string;
  avatarKey: string | null;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// RBAC viewer permissions (M1: UI gating only — the server 403 stays the authority)
// ---------------------------------------------------------------------------

/** GET /api/users/me/permissions — server-wide; owner gets every name listed. */
export interface MyPermissions {
  permissions: string[];
  owner: boolean;
}

export const MANAGE_CHANNELS_PERMISSION = "MANAGE_CHANNELS";
export const SEND_MESSAGES_PERMISSION = "SEND_MESSAGES";
export const KICK_MEMBERS_PERMISSION = "KICK_MEMBERS";
export const BAN_MEMBERS_PERMISSION = "BAN_MEMBERS";
export const MANAGE_SERVER_PERMISSION = "MANAGE_SERVER";
export const MANAGE_ROLES_PERMISSION = "MANAGE_ROLES";
export const MANAGE_MEMBERS_PERMISSION = "MANAGE_MEMBERS";
export const CHANGE_NICKNAME_PERMISSION = "CHANGE_NICKNAME";
export const MANAGE_NICKNAMES_PERMISSION = "MANAGE_NICKNAMES";
export const MANAGE_STORAGE_PERMISSION = "MANAGE_STORAGE";

/** GET/PUT /api/server/storage — the "Server" settings screen (MANAGE_STORAGE). */
export interface StoragePolicy {
  highWatermarkPercent: number;
  lowWatermarkPercent: number;
  /** Local minute-of-day the nightly GC fires at (210 = 03:30). */
  gcMinuteOfDay: number;
  /** False = the scheduled GC never fires (manual "run now" still works). */
  gcEnabled: boolean;
}

export interface StorageUsage {
  totalBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface StorageGcRun {
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  sweptOrphanObjects: number;
  sweptBytes: number;
  purgedMessages: number;
  purgedAttachmentObjects: number;
  finalUsedPercent: number;
}

export interface StorageStatus {
  policy: StoragePolicy;
  usage: StorageUsage;
  running: boolean;
  lastRun: StorageGcRun | null;
}

/** GET /api/channels/{id}/permissions/me — override-aware, per channel. */
export interface ChannelMyPermissions {
  sendMessages: boolean;
  attachFiles: boolean;
}

// ---------------------------------------------------------------------------
// M2: reactions, read states, forward
// ---------------------------------------------------------------------------

/** Pushed on /topic/channel.{id}.reactions — the FULL deterministic snapshot. */
export interface ReactionEvent {
  messageId: number;
  reactions: ReactionSummary[];
}

/** GET /api/read-states — the server pre-computes both counters. */
export interface ChannelReadState {
  channelId: number;
  unreadCount: number;
  mentionCount: number;
  lastReadMessageId: number | null;
  lastMessageId: number | null;
}

/** The server's emoji whitelist (slugs on the wire, glyphs are client-side). */
export const REACTION_CATALOG: readonly { slug: string; glyph: string }[] = [
  { slug: "hundred", glyph: "💯" },
  { slug: "thumbsup", glyph: "👍" },
  { slug: "thumbsdown", glyph: "👎" },
  { slug: "heart", glyph: "❤" },
  { slug: "eyes", glyph: "👀" },
  { slug: "cry", glyph: "😢" },
  { slug: "smile", glyph: "😄" },
  { slug: "facepalm", glyph: "🤦" },
  { slug: "check", glyph: "✅" },
  { slug: "cross", glyph: "❌" },
];

export const REACTION_GLYPH_BY_SLUG: Readonly<Record<string, string>> = Object.fromEntries(
  REACTION_CATALOG.map((entry) => [entry.slug, entry.glyph]),
);

/**
 * POST /api/channels/{target}/messages/forward. Intra-instance: only sourceMessageId
 * set (the server copies everything, trusted=true). Cross-instance snapshot:
 * sourceMessageId null + the copied payload + origin fields (trusted=false).
 */
export interface ForwardMessageRequest {
  sourceMessageId: number | null;
  content: string | null;
  attachments?: { key: string; fileName: string; thumbnailKey?: string | null; durationMillis?: number | null }[] | null;
  originServer?: string | null;
  originChannel?: string | null;
  originAuthorId?: number | null;
  originAuthorName?: string | null;
  originCreatedAt?: string | null;
  originReply?: ReplyInfo | null;
}

/** GET /api/channels/{id}/room — the server creates the room; roomId == channelId. */
export interface RoomInfo {
  janusUrl: string;
  roomId: number;
  token: string | null;
  pin: string | null;
}

export type VoiceMemberStatus = "JOINED" | "LEFT";
export type PresenceStatus = "ONLINE" | "OFFLINE";

export interface VoiceMemberEvent {
  username: string;
  channelId: number;
  status: VoiceMemberStatus;
}

export interface PresenceEvent {
  username: string;
  status: PresenceStatus;
}

/** One remote publisher as announced by Janus (publishers[] entries). */
export interface FeedStream {
  type: "audio" | "video";
  mid: string;
  mindex: number;
  disabled?: boolean;
}

export interface FeedInfo {
  feedId: number;
  display: string;
  streams: FeedStream[];
}

export type RemoteTrackKind = "voice" | "share" | "video";

export type VoiceRoomState = "idle" | "connecting" | "live" | "reconnecting" | "failed";

/**
 * /app/voice.mute|deafen|kick body. The self-toggle path (targetUsername == the
 * sender) needs no permission — Discord-style; the server routes on that equality.
 */
export interface VoiceControlCommand {
  channelId: number;
  targetUsername: string;
  muted: boolean | null;
  deafened: boolean | null;
}

/**
 * /topic/voice.state broadcast (append-only wire contract). muted/deafened are the
 * UNION (compliance semantics); the four origin flags are EXPLICIT because
 * "mod = union ∖ self" is ambiguous when both hold — the server carries both.
 */
export interface VoiceControlState {
  username: string;
  channelId: number;
  muted: boolean;
  deafened: boolean;
  selfMuted: boolean;
  selfDeafened: boolean;
  modMuted: boolean;
  modDeafened: boolean;
}

/** /user/queue/voice.control push targeted at the acted-on member (type=KICKED). */
export interface VoiceControlEvent {
  type: "KICKED";
  channelId: number;
  byUsername: string;
}

// ---------------------------------------------------------------------------
// 1:1 P2P calls (M5) — the server only relays; media flows peer-to-peer
// ---------------------------------------------------------------------------

/** Call signaling wire type — the server relays any type verbatim (stamps `from`). */
export type CallSignalType =
  | "RING" | "ACCEPT" | "REJECT" | "HANGUP" // call lifecycle
  | "OFFER" | "ANSWER" | "ICE"               // WebRTC negotiation
  | "CAM_ON" | "CAM_OFF"                     // UI-only peer camera state
  | "MIC_ON" | "MIC_OFF"                     // UI-only peer mic state
  | "DEAFEN_ON" | "DEAFEN_OFF"               // UI-only peer deafen state
  | "SCREEN_ON" | "SCREEN_OFF";              // UI-only peer share state

/** Mirrors the server DTO (dev.onvoid.RTCIceCandidate fields). */
export interface CallIceCandidate {
  sdp: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** /app/call.signal body (outgoing: no `from` — the server stamps it). */
export interface CallSignal {
  type: CallSignalType;
  to: string;
  sdp: string | null;
  candidate: CallIceCandidate | null;
}

/** The relayed push the target receives on /user/queue/call.signal. */
export interface IncomingCallSignal extends CallSignal {
  from: string;
}

/** GET /api/call/config — RTCIceServer-compatible field names. */
export interface CallConfig {
  iceServers: { urls: string[]; username: string; credential: string }[];
}

/** Where the speaker output of each feed sits right now (diagnostics + UI meters). */
export interface FeedLevels {
  voiceDbfs: number | null;
  shareDbfs: number | null;
}

// ---------------------------------------------------------------------------
// Social layer (M6): friends, DMs, member roster with roles
// ---------------------------------------------------------------------------

/**
 * GET /api/users/me/relationships. The server already folds direction into the
 * type from the CALLER's point of view — PENDING where I am the source becomes
 * PENDING_OUTGOING, where I am the target PENDING_INCOMING.
 */
export type RelationshipType = "FRIEND" | "BLOCKED" | "PENDING_INCOMING" | "PENDING_OUTGOING";

export interface Relationship {
  userId: number;
  username: string;
  type: RelationshipType;
  avatarKey: string | null;
  avatarUrl: string | null;
  /** The NICKNAME the client renders; the username stays a lookup key. */
  displayName: string;
}

/** /user/queue/relationships push — plain string type, always the OTHER side. */
export type RelationshipEventType =
  | "FRIEND_REQUEST"
  | "FRIEND_ACCEPTED"
  | "FRIEND_REMOVED"
  | "BLOCKED"
  | "UNBLOCKED";

export interface RelationshipEvent {
  type: RelationshipEventType;
  userId: number;
  username: string;
}

/**
 * GET /api/channels/dm row. DM channels NEVER appear in GET /api/channels.
 * `name` is "" for 1:1 (never null); ownerId null for 1:1; the server sorts
 * the list by lastMessageAt DESC (nulls last), then id DESC.
 */
export interface DmChannel {
  id: number;
  type: "DM" | "GROUP_DM";
  name: string;
  ownerId: number | null;
  participants: UserSummary[];
  lastMessageId: number | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageAuthorName: string | null;
}

/** /user/queue/dm.channels push — full participant roster, no lastMessage fields. */
export type DmChannelEventType =
  | "CREATED"
  | "PARTICIPANT_ADDED"
  | "PARTICIPANT_REMOVED"
  | "RENAMED"
  | "CLOSED";

export interface DmChannelEvent {
  type: DmChannelEventType;
  channelId: number;
  channelType: "DM" | "GROUP_DM";
  name: string;
  ownerId: number | null;
  participants: UserSummary[];
}

/** GET /api/members row (banned members only appear in GET /api/members/bans). */
export interface ServerMember {
  userId: number;
  username: string;
  avatarUrl: string | null;
  roleIds: number[];
  owner: boolean;
  banned: boolean;
  /** The display name (rename model): render this, never `username`. */
  nickname: string;
}

/** GET /api/roles row — position DESC (highest first), color is ARGB int, nullable. */
export interface Role {
  id: number;
  name: string;
  color: number | null;
  position: number;
  permissions: string[];
  mentionable: boolean;
  hoist: boolean;
  kind: "EVERYONE" | "OWNER" | "CUSTOM";
}

/** /topic/members broadcast — contentless refetch ping (oak reacts with a refetch). */
export interface MemberEvent {
  type: "rolesChanged" | "kicked" | "banned";
  userId: number;
}

/** /user/queue/member.kick push to the VICTIM — the client disconnects itself. */
export interface MemberKickEvent {
  by: string;
  banned: boolean;
}

// ---------------------------------------------------------------------------
// RBAC editor surfaces (M7): catalog, channel overrides, account mutations
// ---------------------------------------------------------------------------

/** GET /api/permissions — the server's catalog, enum order, VIEW_CHANNEL last. */
export interface PermissionCatalogEntry {
  name: string;
  group: "GENERAL" | "TEXT" | "VOICE";
}

/**
 * A role-level channel override. Tri-state per permission: in `allow`, in `deny`
 * (deny wins on the wire), or in NEITHER (neutral — the role's base applies).
 * PUT replaces both sets wholesale; DELETE removes the row entirely.
 */
export interface ChannelOverride {
  channelId: number;
  roleId: number;
  allow: string[];
  deny: string[];
}

/** Per-user override row — `username` arrives on the wire, no client-side join. */
export interface ChannelUserOverride {
  channelId: number;
  userId: number;
  username: string;
  allow: string[];
  deny: string[];
}

/** PATCH /api/users/me/username — fresh tokens in `auth` (the old family is dead). */
export interface UserRenamedResponse {
  user: UserResponse;
  auth: { token: string; refreshToken: string; tokenType: string; expiresIn: number };
}

/** Per-server notification overrides (the record's notifPrefs, oak parity). */
export interface NotificationPrefs {
  mode: "ALL" | "MENTIONS" | "NOTHING";
  suppressEveryoneHere: boolean;
}
