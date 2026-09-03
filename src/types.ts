/** Wire + domain types shared across the spike. Field names are the JSON contract. */

export interface AuthTokens {
  token: string;
  refreshToken: string;
  /** Epoch ms when the access token expires (now + expiresIn*1000). */
  expiresAt: number;
}

export interface Channel {
  id: number;
  name: string;
  type: "TEXT" | "VOICE" | "DM" | "GROUP_DM";
  createdAt: string;
  locked: boolean;
}

export interface UserSummary {
  id: number;
  username: string;
  avatarKey: string | null;
  avatarUrl: string | null;
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

/** Where the speaker output of each feed sits right now (diagnostics + UI meters). */
export interface FeedLevels {
  voiceDbfs: number | null;
  shareDbfs: number | null;
}
