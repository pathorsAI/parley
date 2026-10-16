import type { TranslationKey } from "../i18n";
import type { SettingsCategory } from "../lib/store";

// The panel ids live in the store as SettingsCategory so other surfaces (e.g.
// the titlebar 🌐 menu) can deep-link a panel without importing this file.
export type Category = SettingsCategory;

// `cloudOnly` entries (the account and organizations pages) are compiled out of the OSS edition,
// which has no sign-in at all — so they never appear in that build's nav.
//
// `keywordsKey` is what the nav's search box matches BESIDES the label: panels
// deep enough to hold API keys, rubrics and an MCP endpoint can't be
// found by their one-word titles alone ("金鑰" lives under 供應商, "麥克風"
// under 轉錄). The keyword strings are translated, so search works per-language.
export const NAV: {
  id: Category;
  labelKey: TranslationKey;
  keywordsKey: TranslationKey;
  cloudOnly?: boolean;
  /** Only listed while signed in — an org is a cloud space, so there's nothing to show signed out. */
  signedInOnly?: boolean;
}[] = [
  { id: "basic", labelKey: "settings.nav.basic", keywordsKey: "settings.kw.basic" },
  { id: "account", labelKey: "settings.nav.account", keywordsKey: "settings.kw.account", cloudOnly: true },
  { id: "organizations", labelKey: "settings.nav.organizations", keywordsKey: "settings.kw.organizations", cloudOnly: true, signedInOnly: true },
  { id: "provider", labelKey: "settings.nav.provider", keywordsKey: "settings.kw.provider" },
  { id: "transcription", labelKey: "settings.nav.transcription", keywordsKey: "settings.kw.transcription" },
  { id: "dictionary", labelKey: "settings.nav.dictionary", keywordsKey: "settings.kw.dictionary" },
  // Both panels are cross-platform now. Voice typing runs on Windows (combo
  // triggers only — see VoiceTypingSettings), and Permissions still has one
  // real Windows row (the microphone consent setting). The panels themselves
  // drop the rows that have no Windows meaning, which keeps that judgement next
  // to the control it hides instead of in this list.
  { id: "voiceTyping", labelKey: "settings.nav.voiceTyping", keywordsKey: "settings.kw.voiceTyping" },
  { id: "permissions", labelKey: "settings.nav.permissions", keywordsKey: "settings.kw.permissions" },
  { id: "evaluations", labelKey: "settings.nav.evaluations", keywordsKey: "settings.kw.evaluations" },
  { id: "todos", labelKey: "settings.nav.todos", keywordsKey: "settings.kw.todos" },
  { id: "mcp", labelKey: "settings.nav.mcp", keywordsKey: "settings.kw.mcp" },
  { id: "usage", labelKey: "settings.nav.usage", keywordsKey: "settings.kw.usage" },
];

/** The nav panel a `#settings/<category>` deep-link hash asks for, if valid. */
export function categoryFromHash(): Category | null {
  const seg = globalThis.location.hash.replace(/^#settings\/?/, "");
  return NAV.some((n) => n.id === seg) ? (seg as Category) : null;
}
