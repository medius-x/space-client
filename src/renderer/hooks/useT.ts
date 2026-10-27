import { useStore } from "./useStore";
import { i18nLanguageStore, t, type Translator } from "../../domain/i18n/i18n";

/**
 * The translator hook: subscribing to the resolved language re-renders the
 * component on every flip, while `t` itself stays referentially stable (safe
 * for useCallback/useCallback-stabilized callbacks). Every component that
 * renders localized text calls this itself — including memo components: the
 * useSyncExternalStore inside a memo fires independently of the parent.
 */
export function useT(): Translator {
  useStore(i18nLanguageStore, (lang) => lang);
  return t;
}
