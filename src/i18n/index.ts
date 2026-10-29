import { useCallback, useMemo } from "react";
import { useStore } from "../lib/store";
import { translate, type TranslationKey } from "./messages";

export { LANGUAGE_OPTIONS, translate } from "./messages";
export type { TranslationKey } from "./messages";

export function useI18n() {
  const language = useStore((s) => s.settings.language);
  // Stable until the language changes: components put `t` in effect and
  // callback dependencies, and a new function every render re-runs them every
  // render (the onboarding org step refetched in a loop because of it).
  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
  return useMemo(() => ({ language, t }), [language, t]);
}
