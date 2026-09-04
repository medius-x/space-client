/**
 * The SFU rejoin ladder (oak parity): 5 attempts with delays 1/2/4/8/8 s, then
 * give up and detach. Pure math so the schedule is testable without timers.
 */

export const MAX_VOICE_REJOIN_ATTEMPTS = 5;

/** Delay before attempt N (1-based): 1, 2, 4, 8, then 8 s flat. */
export function rejoinDelayMs(attempt: number): number {
  const bounded = Math.min(Math.max(attempt, 1), MAX_VOICE_REJOIN_ATTEMPTS);
  return [1_000, 2_000, 4_000, 8_000, 8_000][bounded - 1]!;
}

/** True when attempt N has failed and no further attempt may be scheduled. */
export function rejoinExhausted(attempt: number): boolean {
  return attempt >= MAX_VOICE_REJOIN_ATTEMPTS;
}
