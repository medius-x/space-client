import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { useUncachedImage } from "../hooks/useUncachedImage";
import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { RosterState } from "../../domain/stores/RosterStore";
import { paletteColor } from "../../domain/logic/user-palette";

/** A stable EMPTY roster for the session-less path — useStore needs a live store. */
const EMPTY_ROSTER: RosterState = { users: [], presence: new Set(), voiceMembers: new Map() };
const nullRosterStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): RosterState => EMPTY_ROSTER,
};

/**
 * A user's avatar: roster lookup by username → cached image by stable avatarKey;
 * the fallback is a palette-colored circle with the initial (oak's deterministic
 * username→color wheel). `override` wins over the roster — friends and DM
 * participants may not be server members. `session: null` marks a row of a
 * NON-active instance (the aggregated lists): the roster is meaningless there,
 * and the override image loads uncached (no session → no attachment cache).
 * `showPresence` overlays the presence dot on the avatar's bottom-right corner
 * (oak's MemberNode).
 */
export function Avatar({ session, username, size, override, showPresence = false, online = false }: {
  session: ConnectionSession | null;
  username: string;
  size: number;
  override?: { avatarKey: string | null; avatarUrl: string | null } | null;
  showPresence?: boolean;
  online?: boolean;
}): React.JSX.Element {
  const user = useStore(session === null ? nullRosterStore : session.rosterStore, (state) =>
    state.users.find((entry) => entry.username === username) ?? null);
  const source = override ?? user;
  const imageSpec = source !== null && source.avatarKey !== null && source.avatarUrl !== null
    ? { key: source.avatarKey, url: source.avatarUrl }
    : null;
  // Both hooks run unconditionally (hook rules); the session picks the winner.
  const cachedUrl = useAttachmentImage(session, imageSpec);
  const uncachedUrl = useUncachedImage(session === null ? imageSpec : null);
  const imageUrl = session !== null ? cachedUrl : uncachedUrl;

  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {imageUrl !== null ? (
        <img className="avatar" src={imageUrl} alt={username} style={{ width: size, height: size }} draggable={false} />
      ) : (
        <span
          className="avatar avatar-fallback"
          style={{
            width: size,
            height: size,
            background: paletteColor(username),
            // The initials SCALE with the circle (oak paints them onto the canvas
            // at the avatar's size) — a fixed font made small fallbacks (20-26px
            // in Server Settings) carry roster-sized letters spilling out.
            fontSize: Math.max(8, Math.round(size * 0.4)),
          }}
        >
          {/* oak's initials(): the first TWO characters, uppercased ("Al" for "alex"). */}
          {username.trim().length === 0 ? "?" : username.trim().slice(0, 2).toUpperCase()}
        </span>
      )}
      {showPresence ? <span className={"avatar-presence" + (online ? " online" : "")} /> : null}
    </span>
  );
}
