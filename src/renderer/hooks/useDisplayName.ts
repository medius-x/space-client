import { useStore } from "./useStore";
import { displayNameOf } from "../../domain/logic/display-name";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { RosterState } from "../../domain/stores/RosterStore";

/** Stable EMPTY roster for the session-less path — useStore needs a live store. */
const EMPTY_ROSTER: RosterState = { users: [], presence: new Set(), voiceMembers: new Map() };
const nullRosterStore = {
  subscribe: (): (() => void) => () => undefined,
  getSnapshot: (): RosterState => EMPTY_ROSTER,
};

/**
 * The rendered name of a user: their NICKNAME from the live roster (a
 * /topic/users push repaints it everywhere at once); the login never shows.
 */
export function useDisplayName(session: ConnectionSession | null, username: string | null | undefined): string {
  const users = useStore(session === null ? nullRosterStore : session.rosterStore, (state) => state.users);
  return displayNameOf(users, username);
}
