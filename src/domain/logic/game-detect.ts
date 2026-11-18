/**
 * The IGDB game auto-detect verdict (round 2, 2026-11-19): the pure half of the
 * runtime's detector. The manual rules keep their own LIFO verdict
 * (matchRunningActivity); this module picks the GAME line among the running
 * apps the IGDB ladder has already resolved — same LIFO shape: the
 * LATEST-launched resolved game wins, a close falls back to the still-running
 * one, and a manual rule always outranks the automatic line (the Discord
 * model: an explicit binding beats detection).
 */
import type { GameCard, PresenceActivity } from "../../types";

/** One per-exe resolution outcome, kept by the runtime for the session. */
export type GameResolution =
    | { status: "resolved"; card: GameCard } // a confident answer, or a user-pinned pick
    | { status: "none" } // checked — nothing on IGDB matches this exe
    | { status: "dismissed" }; // candidates were offered, the user skipped (this session)

/**
 * The auto-detected game line: among the running processes whose resolution is
 * a RESOLVED card, the one DETECTED LATEST wins — the exact LIFO semantics of
 * matchRunningActivity (stamps from trackProcessDetection; a restart
 * re-stamps). Ties keep the first-seen resolved exe (deterministic). Null when
 * no running app has a resolved game.
 */
export function pickAutoGameLine(
    runningProcessNames: Iterable<string>,
    resolvedByExe: ReadonlyMap<string, GameResolution>,
    detectedAtByName?: ReadonlyMap<string, number>,
): PresenceActivity | null {
  let bestCard: GameCard | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const processName of runningProcessNames) {
    const resolution = resolvedByExe.get(processName);
    if (resolution === undefined || resolution.status !== "resolved") {
      continue;
    }
    const detectedAt = detectedAtByName?.get(processName) ?? Number.NEGATIVE_INFINITY;
    if (bestCard === null || detectedAt > bestAt) { // strict >: ties keep the earlier exe
      bestCard = resolution.card;
      bestAt = detectedAt;
    }
  }
  return bestCard === null ? null
      : { type: "playing", name: bestCard.name, igdbGameId: bestCard.igdbId };
}

/** Whether an exe even participates in the ladder: only real APPLICATIONS the
 *  user did NOT bind a manual rule to (a rule is an explicit override). */
export function isGameDetectCandidate(
    processName: string,
    isApp: boolean,
    manualRuleProcessNames: ReadonlySet<string>,
): boolean {
  return isApp && !manualRuleProcessNames.has(processName);
}
