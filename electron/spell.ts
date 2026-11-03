import { ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import nspell from "nspell";

/**
 * The EMBEDDED spell checker (user decision 2026-11-03): two Hunspell
 * dictionaries (en_US + ru_RU) ship inside the installer and nspell checks
 * words in THIS process. Why not the built-in engine? On Windows it hands
 * languages installed as OS language packs to the system spellchecker, which
 * draws underlines but never populates context-menu misspelling data (the
 * 3-year-old electron/electron#38876) — and our audience has both languages
 * installed. The embedded dictionaries make underlines, suggestions and the
 * custom dictionary behave identically on every machine, offline from the
 * first run (the Discord approach — their spellcheck is their own too).
 *
 * The files live under the renderer's static root (src/renderer/public/spell
 * in dev, out/renderer/spell packaged) — the same root the space-asset://
 * protocol serves; this module reads them with fs (asar-aware).
 */

/** Session spell-check languages (main.ts SPELL_LANGUAGES) → dictionary files. */
const DICTIONARY_FILES: Record<string, { aff: string; dic: string }> = {
  "en-US": { aff: "en_US.aff", dic: "en_US.dic" },
  ru: { aff: "ru_RU.aff", dic: "ru_RU.dic" },
};

/**
 * The Russian dictionary (the Lopatin word list — the same one LibreOffice,
 * Telegram and the browsers ship) carries NO REP table: hunspell's
 * typo-replacement pairs. Without them the suggest engine only n-gram-dances,
 * and the RIGHT word drowns in noise (benchmark 2026-11-03: «превет» ranked
 * «привет» 5th). This table adds the classic Russian phonetic confusions —
 * unstressed vowel pairs and voiced/unvoiced consonants — which lifts the
 * right candidate to the top («превет→привет», «извени→извини»,
 * «зделал→сделал» all 1st). Appended to the affix buffer AT LOAD TIME: the
 * dictionary file itself stays the pristine upstream artifact (its MPL
 * triple-license covers the file as shipped).
 */
const RU_REP_PAIRS: string[] = [
  // unstressed vowels (the а/о and и/е reduction is THE Russian typo class)
  "а о", "о а", "е и", "и е", "ы и", "и ы", "е э", "э е", "я а", "а я",
  "о ё", "ё о", "у ю", "ю у",
  // voiced/unvoiced consonant pairs (final devoicing and assimilation)
  "б п", "п б", "в ф", "ф в", "г к", "к г", "д т", "т д",
  "ж ш", "ш ж", "з с", "с з", "ь ъ", "ъ ь",
];

function buildRuRepBlock(): string {
  const lines = RU_REP_PAIRS.map((pair) => `REP ${pair}`);
  return `\nREP ${lines.length}\n${lines.join("\n")}\n`;
}

type Spell = ReturnType<typeof nspell>;

let staticRoot = "";
let dictionaries: Spell[] | null = null;

/** Lazily loads both dictionaries (~4 MB, once per process). A failed load
 *  degrades the feature, never the app: every check answers "all correct"
 *  (no underlines, no menu block) until the files are readable again. */
function loadedDictionaries(): Spell[] {
  if (dictionaries !== null) {
    return dictionaries;
  }
  const root = path.join(staticRoot, "spell");
  const loaded: Spell[] = [];
  for (const [language, files] of Object.entries(DICTIONARY_FILES)) {
    try {
      const affix = fs.readFileSync(path.join(root, files.aff));
      const dictionary = fs.readFileSync(path.join(root, files.dic));
      const affixWithRep = language === "ru"
        ? Buffer.concat([affix, Buffer.from(buildRuRepBlock())])
        : affix;
      loaded.push(nspell(affixWithRep, dictionary));
    } catch {
      dictionaries = loaded; // partial or empty — checks simply pass
      return loaded;
    }
  }
  dictionaries = loaded;
  return loaded;
}

/** The renderer provider's core: words the NONE of the dictionaries accepts.
 *  A word known to either language is correct (mixed-language typing is the
 *  norm for the ru+en audience). */
export function spellMisspelled(words: readonly string[]): string[] {
  const dicts = loadedDictionaries();
  return words.filter((word) => !dicts.some((dictionary) => dictionary.correct(word)));
}

/** Suggestions for the context menu: both dictionaries' candidates,
 *  dictionary order (en first), deduped, capped like a native menu. */
export function spellSuggestions(word: string): string[] {
  const dicts = loadedDictionaries();
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const dictionary of dicts) {
    for (const candidate of dictionary.suggest(word)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        suggestions.push(candidate);
        if (suggestions.length >= 8) {
          return suggestions;
        }
      }
    }
  }
  return suggestions;
}

/** Add to dictionary: every loaded dictionary accepts the word from now on
 *  (the persisted list re-seeds this at every boot; see main.ts). */
export function spellAddWord(word: string): void {
  for (const dictionary of loadedDictionaries()) {
    dictionary.add(word);
  }
}

export function installSpellIpc(rendererStaticRoot: string, log: (line: string) => void): void {
  staticRoot = rendererStaticRoot;
  ipcMain.handle("space-spell:checkWords", (_event, words: unknown) => {
    if (!Array.isArray(words)) {
      return [];
    }
    // Bounds: the platform sends typing-sized batches, but a hostile
    // renderer must not turn this into a CPU pump — 256 words of ≤200 chars.
    const bounded = words
      .filter((word): word is string => typeof word === "string" && word.length > 0 && word.length <= 200)
      .slice(0, 256);
    return spellMisspelled(bounded);
  });
  ipcMain.handle("space-spell:menuData", (_event, word: unknown) => {
    if (typeof word !== "string" || word.length === 0 || word.length > 100) {
      return { misspelled: false, suggestions: [] };
    }
    const misspelled = spellMisspelled([word]).length > 0;
    return { misspelled, suggestions: misspelled ? spellSuggestions(word) : [] };
  });
  // Warm the dictionaries at boot: the first typed word would otherwise pay
  // the ~4 MB load as a visible typing hiccup.
  setImmediate(() => {
    loadedDictionaries();
    log(`[spell] embedded dictionaries ready (${Object.keys(DICTIONARY_FILES).join("+")})`);
  });
}
