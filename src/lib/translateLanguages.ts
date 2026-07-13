/**
 * Target languages for live translation (`gemini-3.5-live-translate-preview`).
 *
 * The model auto-detects the source language and supports 70+ targets; this is a
 * curated shortlist of common ones with BCP-47 codes. Kept separate from
 * `LANGUAGE_OPTIONS` (the two supported UI locales) so translate targets aren't
 * coupled to the app's UI language.
 */
export interface TranslateLanguage {
  /** BCP-47 code sent as `translationConfig.targetLanguageCode`. */
  code: string;
  /** English name (for search / secondary label). */
  label: string;
  /** Endonym shown in the picker. */
  nativeLabel: string;
  /** ISO 3166-1 alpha-2 country code for the circle flag in `/public/flags`. */
  flag: string;
}

export const TRANSLATE_LANGUAGES: readonly TranslateLanguage[] = [
  { code: "en", label: "English", nativeLabel: "English", flag: "us" },
  { code: "zh-Hant", label: "Chinese (Traditional)", nativeLabel: "繁體中文", flag: "tw" },
  { code: "zh-Hans", label: "Chinese (Simplified)", nativeLabel: "简体中文", flag: "cn" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", flag: "jp" },
  { code: "ko", label: "Korean", nativeLabel: "한국어", flag: "kr" },
  { code: "es", label: "Spanish", nativeLabel: "Español", flag: "es" },
  { code: "fr", label: "French", nativeLabel: "Français", flag: "fr" },
  { code: "de", label: "German", nativeLabel: "Deutsch", flag: "de" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português", flag: "pt" },
  { code: "it", label: "Italian", nativeLabel: "Italiano", flag: "it" },
  { code: "ru", label: "Russian", nativeLabel: "Русский", flag: "ru" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", flag: "sa" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी", flag: "in" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia", flag: "id" },
  { code: "th", label: "Thai", nativeLabel: "ไทย", flag: "th" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt", flag: "vn" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands", flag: "nl" },
  { code: "pl", label: "Polish", nativeLabel: "Polski", flag: "pl" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe", flag: "tr" },
  { code: "uk", label: "Ukrainian", nativeLabel: "Українська", flag: "ua" },
] as const;

/** Human label for a stored code (falls back to the raw code). */
export function translateLanguageLabel(code: string): string {
  const found = TRANSLATE_LANGUAGES.find((l) => l.code === code);
  return found ? found.nativeLabel : code;
}

/** Combined audio-token price for gemini-3.5-live-translate-preview: input
 *  $0.0053/min + output $0.0315/min (output dominates). Live estimate only —
 *  real billing is metered server-side. */
export const TRANSLATE_USD_PER_MINUTE = 0.0053 + 0.0315;
