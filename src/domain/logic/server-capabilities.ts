import type { ServerProfile } from "../../types";

/**
 * The client half of the server-compatibility skeleton (user decision 2026-10-15).
 * The server reports post-0.1.0 feature flags in ServerProfile.capabilities; the
 * client hides a feature's UI when its flag is absent, so a newer client degrades
 * gracefully against an older server.
 *
 * Absence of the whole field = an old server that predates the skeleton = the
 * unconditional 0.1.0 base — which by doctrine carries NO flags, so "no field"
 * and "empty array" answer every hasServerCapability() query identically.
 */
export function hasServerCapability(profile: ServerProfile | null, flag: string): boolean {
  return profile?.capabilities?.includes(flag) ?? false;
}
