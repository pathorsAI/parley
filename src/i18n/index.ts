import { useStore } from "../lib/store";
import { translate, type TranslationKey } from "./messages";

export { LANGUAGE_OPTIONS, translate } from "./messages";
export type { TranslationKey } from "./messages";

export function useI18n() {
  const language = useStore((s) => s.settings.language);
  return {
    language,
    t: (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
  };
}
