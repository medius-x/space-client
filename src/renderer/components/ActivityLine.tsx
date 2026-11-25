import type { Translator } from "../../domain/i18n/i18n";
import type { PresenceActivity } from "../../types";
import { ACTIVITY_KIND_GLYPHS, formatActivityLine } from "../activity-display";
import { MaterialGlyph } from "./MaterialGlyph";

/**
 * The rendered activity line (the roster row and the settings rule row): an
 * IGDB game line leads with the sports_esports Material Symbol (the user's
 * glyph pick 2026-11-19 — was the 🎮 emoji); a MANUAL line leads with its
 * KIND's glyph the same way (user request 2026-11-25: the word prefixes read
 * as clutter next to the glyphed game lines — "Играет" became sports_esports
 * everywhere, not just on detected games). "custom" has no glyph and no
 * prefix — the bare name, as it always was.
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
  const glyph = ACTIVITY_KIND_GLYPHS[activity.type];
  if (glyph !== undefined) {
    return (
      <>
        <MaterialGlyph name={glyph} className="lead-glyph" />
        {activity.name}
      </>
    );
  }
  return <>{formatActivityLine(t, activity)}</>; // "custom": no prefix to glyph
}
