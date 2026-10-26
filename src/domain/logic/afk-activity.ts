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
