import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";

/**
 * A user's avatar: roster lookup by username → cached image by stable avatarKey;
 * a colored circle with the initial stays the fallback (no avatar / not loaded).
 * `override` wins over the roster — friends and DM participants may not be server
 * members, but their relationship/participant rows carry avatar fields of their own.
 */
export function Avatar({ session, username, size, override }: {
  session: ConnectionSession;
  username: string;
  size: number;
  override?: { avatarKey: string | null; avatarUrl: string | null } | null;
}): React.JSX.Element {
  const user = useStore(session.rosterStore, (state) => state.users.find((entry) => entry.username === username) ?? null);
  const source = override ?? user;
  const imageUrl = useAttachmentImage(
    session,
    source !== null && source.avatarKey !== null && source.avatarUrl !== null
      ? { key: source.avatarKey, url: source.avatarUrl }
      : null,
  );

  if (imageUrl !== null) {
    return <img className="avatar" src={imageUrl} alt={username} style={{ width: size, height: size }} draggable={false} />;
  }
  return (
    <div className="avatar avatar-fallback" style={{ width: size, height: size }}>
      {(username.charAt(0) || "?").toUpperCase()}
    </div>
  );
}
