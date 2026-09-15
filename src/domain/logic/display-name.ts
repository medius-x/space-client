import type { UserSummary } from "../../types";

/**
 * The rename model: the NICKNAME is the only name any surface renders; the
 * username (login) is the stable lookup key and never surfaces. Falls back to
 * the raw key when the roster has not resolved the user yet (or a non-active
 * instance whose roster we do not hold).
 */
export function displayNameOf(users: readonly UserSummary[], username: string | null | undefined): string {
  if (username === null || username === undefined) {
    return "?";
  }
  return users.find((user) => user.username === username)?.displayName ?? username;
}
