/** The AFK grace period for SYSTEM-WIDE input idle: activity in ANY application
 *  (typing in a browser, moving the mouse over an unrelated window) keeps the
 *  member out of AFK — "actively using the computer" is the user's criterion,
 *  not "active in space". */
export const AFK_IDLE_GRACE_SECONDS = 60;

/**
 * Whether the member counts as ACTIVE for the AFK sweep: currently speaking in
 * the room, streaming outgoing media (a live screen share or camera — someone
 * showing something is present by definition, whatever the input idle timer
 * says), OR the system-wide input idle under the grace period. The reporter
 * sends a heartbeat only while this holds; the server treats silence as idle.
 */
export function isAfkActive(idleSeconds: number, speaking: boolean, streaming = false): boolean {
  return speaking || streaming || idleSeconds < AFK_IDLE_GRACE_SECONDS;
}

/** The ROSTER AFK threshold (user decision 2026-11-04, 5 minutes): system-wide
 *  input idle beyond this marks the member AWAY in the roster — provided they
 *  hold no live voice connection (see {@link isRosterAway}). This is the
 *  CLIENT's own decision, a SEPARATE entity from the voice AFK sweep; the
 *  server's AFK-channel timeout has no say here. */
export const ROSTER_AFK_AFTER_SECONDS = 300;

/**
 * Whether the member is AWAY for the roster dot: no system-wide input for the
 * roster threshold AND no live voice room or 1:1 call. A live call is presence
 * by definition (user decision 2026-11-19, Discord parity, live report: a
 * member LISTENING to a screen share with a quiet mic at the tick moment went
 * yellow — an instantaneous speaking sample cannot gate the dot; if they are in
 * the call, they are talking to people and are at the computer). The flips of
 * this verdict ride {@code /app/roster.afk}; the server only relays them. A
 * MANUAL "away" pin (the status menu) bypasses this verdict entirely.
 */
export function isRosterAway(idleSeconds: number, inVoice: boolean): boolean {
  return !inVoice && idleSeconds >= ROSTER_AFK_AFTER_SECONDS;
}
