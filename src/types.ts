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
