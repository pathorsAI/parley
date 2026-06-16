import { useStore } from "../lib/store";
import type { AppLanguage } from "../lib/types";
import { DICTS, LANGUAGE_OPTIONS, zhTW, type TranslationKey } from "./messages";

export { LANGUAGE_OPTIONS };
export type { TranslationKey };

export function translate(language: AppLanguage, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = DICTS[language]?.[key] ?? zhTW[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}

export function useI18n() {
  const language = useStore((s) => s.settings.language);
  return {
    language,
    t: (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
  };
}
