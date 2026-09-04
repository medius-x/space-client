import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";

/**
 * A user's avatar: roster lookup by username → cached image by stable avatarKey;
 * a colored circle with the initial stays the fallback (no avatar / not loaded).
 */
export function Avatar({ session, username, size }: {
  session: ConnectionSession;
  username: string;
  size: number;
}): React.JSX.Element {
  const user = useStore(session.rosterStore, (state) => state.users.find((entry) => entry.username === username) ?? null);
  const imageUrl = useAttachmentImage(
    session,
    user !== null && user.avatarKey !== null && user.avatarUrl !== null
      ? { key: user.avatarKey, url: user.avatarUrl }
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
