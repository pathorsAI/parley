import { useStore } from "../lib/store";
import { LANGUAGE_OPTIONS, translate, type TranslationKey } from "./messages";

export { LANGUAGE_OPTIONS, translate };
export type { TranslationKey };

export function useI18n() {
  const language = useStore((s) => s.settings.language);
  return {
    language,
    t: (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
  };
}
