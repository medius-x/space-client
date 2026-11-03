import type { FormatKind } from "./mention-segmenter";

/**
 * The composer's formatting actions shared by BOTH editor modes (the plain
 * textarea and the WYSIWYG contentEditable work on the SAME flat model — the
 * wire string with Discord markers). Everything here is pure string math.
 */

/** The marker pair a format kind serializes to — the wire format itself. */
export const FORMAT_MARKER_OF: Record<FormatKind, string> = {
  bold: "**",
  italic: "*",
  underline: "__",
  strike: "~~",
  spoiler: "||",
  code: "`",
};

/** The reverse lookup: a marker's format kind (undefined for a foreign string). */
export const FORMAT_KIND_OF_MARKER: Readonly<Record<string, FormatKind>> = {
  "**": "bold",
  "*": "italic",
  "__": "underline",
  "~~": "strike",
  "||": "spoiler",
  "`": "code",
};

/** Wraps [start, end) of the text with the marker pair — or UNWRAPS when the
 *  range already sits exactly inside one (pressing the hotkey again reverts).
 *  An empty range just drops the pair at the position, so typing starts
 *  formatted. Returns the next text plus the range to select afterwards (the
 *  wrapped content, wherever it lands). */
export function wrapSelectionInMarker(
  text: string,
  start: number,
  end: number,
  marker: string,
): { next: string; nextStart: number; nextEnd: number } {
  const wrappedBefore = text.slice(Math.max(0, start - marker.length), start) === marker;
  const wrappedAfter = text.slice(end, end + marker.length) === marker;
  if (wrappedBefore && wrappedAfter) {
    return {
      next: text.slice(0, start - marker.length) + text.slice(start, end) + text.slice(end + marker.length),
      nextStart: start - marker.length,
      nextEnd: end - marker.length,
    };
  }
  return {
    next: `${text.slice(0, start)}${marker}${text.slice(start, end)}${marker}${text.slice(end)}`,
    nextStart: start + marker.length,
    nextEnd: end + marker.length,
  };
}
