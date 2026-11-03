/**
 * Spell-check helpers (2026-11-03): pure word-boundary math for the composer's
 * suggestion menu plus the KV sanitizers for the custom dictionary. The
 * misspelled WORD itself comes from Chromium (the webContents context-menu
 * params); what the renderer needs is WHERE that word sits in the textarea so
 * a picked suggestion can replace it locally (the applyEditorText idiom —
 * synchronous, no IPC round trip for the replacement itself).
 */

/** A word character for boundary purposes: letters/digits of any alphabet,
 *  inner apostrophes (don't) and hyphens (кто-то). */
const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

/** The word [start, end) range around a caret position in a textarea's value,
 *  or null when the caret is not touching a word (whitespace, punctuation,
 *  past-the-end). A caret ON a boundary belongs to the word it touches — the
 *  caret Chromium places at a right-click sits inside or right after the
 *  clicked word. */
export function wordRangeAt(text: string, caret: number): { start: number; end: number } | null {
  const position = Math.max(0, Math.min(caret, text.length));
  let index = position;
  // A caret just AFTER a word (its end boundary) still names that word —
  // click positions land there constantly.
  if (index >= text.length || !WORD_CHAR.test(text[index] ?? "")) {
    if (index > 0 && WORD_CHAR.test(text[index - 1] ?? "")) {
      index -= 1;
    } else {
      return null;
    }
  }
  let start = index;
  while (start > 0 && WORD_CHAR.test(text[start - 1] ?? "")) {
    start -= 1;
  }
  let end = index;
  while (end < text.length && WORD_CHAR.test(text[end] ?? "")) {
    end += 1;
  }
  return start < end ? { start, end } : null;
}

/** Hard cap for the persisted custom dictionary — a runaway list must never
 *  grow the KV payload unbounded (the same reasoning as recentExpressions). */
export const MAX_SPELL_WORDS = 1000;

function cleanSpellWord(word: string): string | null {
  const trimmed = word.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    return null;
  }
  return trimmed;
}

/** KV sanitizer: keeps trimmed non-empty strings, drops duplicates and junk
 *  (hand-edited KV is never trusted — the store's standing rule). */
export function sanitizeSpellWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const word = cleanSpellWord(entry);
    if (word === null || seen.has(word)) {
      continue;
    }
    seen.add(word);
    clean.push(word);
    if (clean.length >= MAX_SPELL_WORDS) {
      break; // cap, first come first served
    }
  }
  return clean;
}

/** The "Add to dictionary" write: append one word, keep the list deduped and
 *  capped. A no-op (duplicate) returns the SAME reference — callers may diff. */
export function withAddedSpellWord(words: readonly string[], word: string): string[] {
  const clean = cleanSpellWord(word);
  if (clean === null || words.includes(clean)) {
    return [...words];
  }
  const next = [...words, clean];
  return next.length > MAX_SPELL_WORDS ? next.slice(next.length - MAX_SPELL_WORDS) : next;
}
