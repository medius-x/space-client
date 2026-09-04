/**
 * P2P ICE-restart policy (the oak seam, transplanted): only the CALLER may restart
 * — the role is fixed by the RING/ACCEPT handshake, so glare stays impossible. The
 * callee just waits and answers an incoming restart offer in place. Pure so the
 * state decisions are testable without a peer connection.
 */

export type IcePlan = "none" | "schedule-restart" | "await-caller-restart" | "reset-backoff";

export function planIceRestart(isCaller: boolean, connectionState: RTCPeerConnectionState): IcePlan {
  if (connectionState === "failed") {
    return isCaller ? "schedule-restart" : "await-caller-restart";
  }
  if (connectionState === "connected") {
    return "reset-backoff";
  }
  return "none"; // new/connecting/disconnected — brief blips heal themselves
}

export const ICE_RESTART_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** Delay before restart N (1-based); capped at 16 s, retries forever (the user hangs up). */
export function iceRestartDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), ICE_RESTART_LADDER_MS.length) - 1;
  return ICE_RESTART_LADDER_MS[index]!;
}
