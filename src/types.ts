/** Wire + domain types shared across the spike. Field names are the JSON contract. */

export interface AuthTokens {
  token: string;
  refreshToken: string;
  /** Epoch ms when the access token expires (now + expiresIn*1000). */
  expiresAt: number;
}

export type ChannelType = "TEXT" | "VOICE" | "DM" | "GROUP_DM" | "CATEGORY";

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  createdAt: string;
  locked: boolean;
  /** The CATEGORY channel this TEXT/VOICE channel groups under (Discord's
   *  category); null = top level. Categories themselves never carry one.
   *  Wire append-only — rows from before the field may deserialize without it. */
  parentId: number | null;
  /** The manual sidebar order; (position, id) is the sort key. */
  position: number;
  /** THE server's AFK channel (the idle-sweep target; one per server, a server-wide
   *  flag — not per-viewer). Absent = false (rows from before the field). */
  afk?: boolean;
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
  /** Intrinsic pixel dimensions (measured by the uploader's decode; null on
   *  rows from before the field — the renderer then estimates until the bytes
   *  arrive). Server passthrough, wire append-only. */
  width: number | null;
  height: number | null;
  /** The object's byte size, known only to the SENDER (File.size at upload —
   *  the server never terminates the bytes). Shown by the plain-file card; null
   *  on rows from before the field. Same trust model as width/height. */
  sizeBytes: number | null;
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
  /** Channel pin (Discord-style). pinnedBy is the PINNER's username (not the author),
   *  pinnedAt the pin moment — both null while unpinned. Pin/unpin pushes ride the
   *  .edited topic as a full row replacement. */
  pinned: boolean;
  pinnedBy: string | null;
  pinnedAt: string | null;
  /** The denormalized sticker copy (phase 2, appended — wire append-only); null = none.
   *  A sticker-only message has content null. */
  sticker: StickerRef | null;
}

/** GET /api/search/messages — one search page: the cursor-independent total hit count plus
 *  the newest-first results (page with beforeId = the last result's id). */
export interface SearchMessagesResult {
  total: number;
  results: Message[];
}

// ---------------------------------------------------------------------------
// Discussions (threads) — a DISCUSSION channel + a frozen origin-message snapshot
// ---------------------------------------------------------------------------

/** The discussion wire view. `id` is the DISCUSSION channel's id (messages/subscriptions are
 *  addressed by it); the origin* block is the frozen start-message snapshot (survives the
 *  origin's deletion); `tracked` is viewer-scoped (do I follow this discussion). */
export interface Discussion {
  id: number;
  parentChannelId: number;
  originMessageId: number;
  originSnippet: string;
  originAuthorId: number | null;
  originAuthorName: string | null;
  originCreatedAt: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  replyCount: number;
  tracked: boolean;
}

/** Pushed on the PARENT channel's `/topic/channel.{parent}.discussions` topic. REMOVED is the
 *  only close signal — an open view must kick back to the channel (its `discussion` is null).
 *  CREATED/ACTIVITY carry the FULL row — a peer sitting in the channel never fetched the
 *  channel's list, so the push itself must render the tile; the row's `tracked` is broadcast
 *  as false for everyone (viewer-scoped by nature) and each client merges its own state.
 *  `actorUsername` = who started/posted/closed — the origin author's client turns the FIRST
 *  reply into a mention-style ping keyed on it. ACTIVITY also carries the posted `message`:
 *  clients that never subscribed to the thread's own topic run MENTION detection over it
 *  (a mention in a thread subscribes and notifies the mentioned user). */
export interface DiscussionEvent {
  type: "CREATED" | "ACTIVITY" | "REMOVED";
  discussionId: number;
  parentChannelId: number;
  originMessageId: number;
  lastMessageAt: string | null;
  replyCount: number;
  actorUsername: string | null;
  discussion: Discussion | null;
  message: Message | null;
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
// Invite links (the Invites settings section + the Register tab)

/** One ACTIVE invite link of the Invites settings list (GET/POST /api/invites). The full
 *  secret never rides the DTO — only an 8-char preview; the copyable artifact is the
 *  assembled link (origin from the advertised connection info, secret in the hash). */
export interface InviteLink {
  id: number;
  secretPreview: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  link: string;
}

/** The Invites section in one fetch: the TTL setting plus the active links. */
export interface InvitesStatus {
  ttlMinutes: number;
  invites: InviteLink[];
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

/** GET /api/emojis row — the server-scoped custom-emoji catalog (phase 1, flat list).
 *  `url` re-signs on every fetch (the attachment discipline); clients cache by `key`.
 *  Message text references emojis as plain ":name:" tokens resolved CLIENT-side. */
export interface CustomEmoji {
  id: number;
  name: string;
  url: string | null;
  key: string;
  uploadedBy: number | null;
}

/** GET /api/sticker-packs sticker row (phase 2). Same URL discipline as CustomEmoji. */
export interface Sticker {
  id: number;
  name: string;
  url: string | null;
  key: string;
  uploadedBy: number | null;
}

/** GET /api/sticker-packs row — the whole catalog in one fetch (the tray and the
 *  settings section render from it; one /topic/stickers ping refetches it). */
export interface StickerPack {
  id: number;
  name: string;
  stickers: Sticker[];
}

/** The sticker a message carries — a DENORMALIZED copy stamped at send time. The
 *  catalog row may be gone (deleted): the key's object dies with the sweep and the
 *  renderer shows a tombstone; the ref itself never changes. */
export interface StickerRef {
  name: string;
  key: string;
  url: string | null;
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

/** GET /api/users/me/permissions — server-wide; owner gets every name listed.
 *  `dmRestricted` (3rd field, wire append-only) mirrors the subtractive
 *  RESTRICT_PRIVATE_MESSAGES role bit — deliberately NOT part of `permissions`
 *  (that list is grants; the flag is computed server-side from raw held roles). */
export interface MyPermissions {
  permissions: string[];
  owner: boolean;
  dmRestricted?: boolean;
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
export const MANAGE_EMOJIS_PERMISSION = "MANAGE_EMOJIS";

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

/** GET /api/server/health — the live status of the backing services
 *  (healthcheck round 2026-10-07, MANAGE_STORAGE). Two facets per service:
 *  a probe the server itself runs (can it actually use the integration)
 *  and the docker container state. */
export interface ServiceHealthCheck {
  status: "UP" | "DOWN" | "DISABLED" | "TIMEOUT";
  latencyMillis: number | null;
  detail: string | null;
}

export interface ContainerHealthCheck {
  /** Docker state uppercased (RUNNING/EXITED/…), ABSENT when no container
   *  matches the configured name, UNKNOWN when docker is unavailable. */
  status: string;
  /** The image HEALTHCHECK verdict; NONE when the image defines none. */
  health: string | null;
  detail: string | null;
}

export interface ServerHealthEntry {
  name: string;
  service: ServiceHealthCheck;
  container: ContainerHealthCheck;
}

export interface ServerHealth {
  checkedAt: string;
  services: ServerHealthEntry[];
}

/** GET /api/channels/{id}/permissions/me — override-aware, per channel. The `stream`
 *  bit feeds the voice share/camera gate (security round 6); it is client-side only —
 *  the gateway has no video mute, so the button hiding IS the enforcement. */
export interface ChannelMyPermissions {
  sendMessages: boolean;
  attachFiles: boolean;
  stream: boolean;
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
  { slug: "heart", glyph: "❤️" }, // U+FE0F matters: the bare U+2764 renders TEXT-style (monochrome black) in Chromium
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
  attachments?: { key: string; fileName: string; thumbnailKey?: string | null; durationMillis?: number | null; width?: number | null; height?: number | null; sizeBytes?: number | null }[] | null;
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

/** /user/queue/voice.invite — a live "join me in this room" card (the sidebar's
 *  hover invite). The server stamps `from` (the sender's LOGIN) and resolves
 *  `channelName` itself — the receiver's store may not hold the room. No
 *  persistence: an offline receiver never sees it. */
export interface IncomingVoiceInvite {
  channelId: number;
  channelName: string;
  from: string;
  to: string;
}

export interface PresenceEvent {
  username: string;
  status: PresenceStatus;
}

/**
 * STOMP /app/ping → /user/queue/ping: the client's epoch-millis timestamp,
 * echoed VERBATIM by the server (a bare JSON number both ways — the same
 * Long-timestamp-body convention as /topic/channels.changed). RTT is computed
 * client-side as now − the echoed value; the server adds no timing of its own.
 */
export type PingEcho = number;

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
 * `permMuted` (security round 6) is the SPEAK-permission mute: paints like a
 * moderator mute, but neither a self-unmute nor a moderator's Unmute lifts it.
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
  permMuted: boolean;
}

/** /user/queue/voice.control push targeted at the acted-on member: type=KICKED (a
 *  moderator/enforcer eviction — tear the voice down) or type=MOVED (the AFK sweep —
 *  rejoin into `channelId`); the sweep's push carries a null byUsername. */
export interface VoiceControlEvent {
  type: "KICKED" | "MOVED";
  channelId: number;
  byUsername: string | null;
}

/** GET/PUT /api/server/afk — the AFK sweep settings (channel null = feature off). */
export interface AfkSettings {
  afkChannelId: number | null;
  afkTimeoutMinutes: number | null;
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

/** GET /api/members row (removed members only appear in GET /api/members/bans). */
export interface ServerMember {
  userId: number;
  username: string;
  avatarUrl: string | null;
  roleIds: number[];
  owner: boolean;
  banned: boolean;
  /** The display name (rename model): render this, never `username`. */
  nickname: string;
  /** Permanent removal ("Remove from server") — true only on /api/members/bans rows;
   *  there is no undo, so the client renders such rows without actions. */
  removed?: boolean;
  /** Holds a role with RESTRICT_PRIVATE_MESSAGES: the client dims DM entry points
   *  toward this member (9th field, wire append-only). */
  dmRestricted?: boolean;
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
  type: "rolesChanged" | "kicked" | "banned" | "removed";
  userId: number;
}

/** /user/queue/member.kick push to the VICTIM — the client disconnects itself. */
export interface MemberKickEvent {
  by: string;
  banned: boolean;
  /** Permanent removal — no reconnect hint; the account can never rejoin. */
  removed?: boolean;
}

// ---------------------------------------------------------------------------
// Server-ownership transfer
// ---------------------------------------------------------------------------

/** GET /api/ownership/pending row — the single live PENDING offer (party-scoped). */
export interface OwnershipTransfer {
  id: number;
  fromUserId: number;
  fromUsername: string;
  fromDisplayName: string;
  toUserId: number;
  toUsername: string;
  toDisplayName: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED";
  /** ISO-8601 UTC string. */
  createdAt: string;
}

/** GET /api/ownership/pending response — always JSON, `pending` null for a non-party. */
export interface PendingOwnershipTransfer {
  pending: OwnershipTransfer | null;
}

/** /user/queue/ownership push (both parties) — the reaction is the same refetch. */
export interface OwnershipEvent {
  type: "OFFERED" | "ACCEPTED" | "DECLINED" | "CANCELLED";
  transfer: OwnershipTransfer;
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
