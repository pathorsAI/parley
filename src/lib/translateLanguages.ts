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
}

export const TRANSLATE_LANGUAGES: readonly TranslateLanguage[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "zh-Hant", label: "Chinese (Traditional)", nativeLabel: "繁體中文" },
  { code: "zh-Hans", label: "Chinese (Simplified)", nativeLabel: "简体中文" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "th", label: "Thai", nativeLabel: "ไทย" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
  { code: "pl", label: "Polish", nativeLabel: "Polski" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
  { code: "uk", label: "Ukrainian", nativeLabel: "Українська" },
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
