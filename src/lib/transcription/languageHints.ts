//! Which languages to tell the STT to expect.
//!
//! Shared by every transcription entry point (file ingest and live voice
//! typing) so a dictation and an uploaded recording bias the recognizer the
//! same way.

import type { Settings } from "../types";

/** Derive BCP-47 language hints from settings; empty array = auto-detect. */
export function languageHintsFromSettings(settings: Settings): string[] {
  // The UI language is the only locale signal we currently persist. Map it to a
  // hint and pair it with English, which covers the common bilingual case.
  if (settings.language === "zh-TW") return ["zh", "en"];
  if (settings.language === "en") return ["en"];
  return [];
}
