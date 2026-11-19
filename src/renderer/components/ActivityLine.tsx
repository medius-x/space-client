import type { Translator } from "../../domain/i18n/i18n";
import type { PresenceActivity } from "../../types";
import { formatActivityLine } from "../activity-display";
import { MaterialGlyph } from "./MaterialGlyph";

/**
 * The rendered activity line (the roster row and the settings rule row): an
 * IGDB-detected game leads with the sports_esports Material Symbol instead of
 * any words (the user's glyph pick 2026-11-19 — was the 🎮 emoji); manual
 * kinds keep their localized verb prefixes — only the PICKER went all-glyph.
 */
export function ActivityLine({ t, activity }: {
  t: Translator;
  activity: Pick<PresenceActivity, "type" | "name" | "igdbGameId">;
}) {
  if (activity.igdbGameId != null) {
    return (
      <>
        <MaterialGlyph name="sports_esports" className="lead-glyph" />
        {activity.name}
      </>
    );
  }
  return <>{formatActivityLine(t, activity)}</>;
}
