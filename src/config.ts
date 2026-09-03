/**
 * Spike-wide constants. The server/Janus hosts are local-dev fixtures; the login screen
 * lets the user override the REST base URL, and the Janus URL always comes from
 * GET /api/channels/{id}/room (never hardcoded into the protocol modules).
 */
export const DEFAULT_REST_BASE_URL = "http://localhost:8080";

/** Janus long-poll client timeout — must sit above the gateway's ~30 s empty hold. */
export const JANUS_POLL_TIMEOUT_MS = 40_000;

/** A Janus poll error is treated as "gateway alive" when it surfaced after this long. */
export const JANUS_POLL_ALIVE_MS = 20_000;

/** Janus session keepalive cadence. */
export const JANUS_KEEPALIVE_MS = 25_000;

/** STOMP 1.2 heartbeat the client advertises (matches the server broker). */
export const STOMP_HEARTBEAT_MS = 10_000;

/** STOMP read watchdog: close the socket after this much inbound silence. */
export const STOMP_READ_DEAD_MS = 20_000;

/** Level-meter / speaking-detection polling cadence. */
export const LEVEL_POLL_MS = 100;
