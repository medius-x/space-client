/**
 * The thin i18n core (feature D, localization round 2026-10-27): dictionaries
 * + a resolved language + a translate function. NO new persistence — the
 * source of truth is SettingsStore.language; this module only holds the
 * RESOLVED value ("system" → navigator.language) plus the dictionaries.
 *
 * The resolved language is MODULE STATE and therefore PER-PROCESS: the main
 * window sets it from the settings subscription (runtime.ts), the toast and
 * pop-out windows from the spaceI18n bridge (main.tsx), the main process from
 * the space-i18n:sync IPC (electron/main.ts). A process that never sets it
 * silently stays English — every installer of a language must call
 * setLanguage (the four points are covered in phase 1).
 */
import { EN, type MessageKey } from "./en";
import { RU } from "./ru";
import { Emitter } from "../lib/store";

export type { MessageKey } from "./en";

export type UiLang = "en" | "ru";
/** The stored setting: "system" resolves per navigator at apply time. */
export type LanguageSetting = UiLang | "system";

/** Interpolation params — {name} placeholders in the template; a numeric
 *  "count" additionally drives the plural category. */
export type TranslateParams = Record<string, string | number>;

/** The plural-forms value of a dictionary entry. EN fills one/other; RU fills
 *  one/few/many/other (the test walks the number ladder to keep them full). */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other?: string;
}

export type Translator = (key: MessageKey, params?: TranslateParams) => string;

const DICTS: Record<UiLang, Record<string, string | PluralForms>> = { en: EN, ru: RU };

const pluralRulesCache = new Map<UiLang, Intl.PluralRules>();

function pluralCategory(lang: UiLang, count: number): Intl.LDMLPluralRule {
  let rules = pluralRulesCache.get(lang);
  if (rules === undefined) {
    rules = new Intl.PluralRules(lang);
    pluralRulesCache.set(lang, rules);
  }
  return rules.select(count);
}

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) {
    return template;
  }
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

/** The pure translator — for domain logic (which takes a lang parameter) and
 *  tests. Unknown keys ladder down ru → en → the key itself (dev diagnostics:
 *  a raw key on screen names the bug). */
export function tf(lang: UiLang, key: MessageKey, params?: TranslateParams): string {
  const entry: string | PluralForms | undefined = DICTS[lang][key] ?? EN[key];
  if (entry === undefined) {
    return key;
  }
  if (typeof entry === "string") {
    return interpolate(entry, params);
  }
  const count = params?.count;
  const category = typeof count === "number" ? pluralCategory(lang, count) : undefined;
  const template = (category !== undefined ? entry[category] : undefined)
    ?? entry.other
    ?? Object.values(entry).find((form) => form !== undefined);
  return template === undefined ? key : interpolate(template, params);
}

/** "system" resolves via the navigator (any ru* locale → ru, else en);
 *  explicit settings win. Pure — tested directly. */
export function resolveUiLanguage(setting: LanguageSetting, navigatorLanguage: string | null): UiLang {
  if (setting === "en" || setting === "ru") {
    return setting;
  }
  return navigatorLanguage !== null && navigatorLanguage.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let language: UiLang = "en";

class I18nLanguageStore extends Emitter {
  getSnapshot = (): UiLang => language;

  /** The only writer — the exported setLanguage delegates here (emit is
   *  protected on Emitter, same as every other store's apply). */
  set(lang: UiLang): void {
    if (lang === language) {
      return;
    }
    language = lang;
    this.emit();
  }
}

/** Reactive handle for React (useT): the snapshot is a primitive, so the
 *  referential-stability store contract holds by value. */
export const i18nLanguageStore = new I18nLanguageStore();

export function currentLang(): UiLang {
  return language;
}

/** Set the process language; a no-op (no emit) when it did not change. */
export function setLanguage(lang: UiLang): void {
  i18nLanguageStore.set(lang);
}

/** The current-language translator — for code OUTSIDE the React tree
 *  (runtime.ts toasts/confirms, the main process tray). Reads the language at
 *  call time, so closures and cached callbacks never freeze a stale language;
 *  never hoist a translated string into a module-level constant. */
export const t: Translator = (key, params) => tf(language, key, params);

/** English-bound translator — the default injection for code that must not
 *  depend on module state (the provisioning pipeline's existing tests). */
export const enTranslator: Translator = (key, params) => tf("en", key, params);
