// The settings a fresh install starts from, and the pieces of them that other
// modules (migrations, onboarding) also need.

import type { AppLanguage, GettingStartedState, HintId, Settings } from "../types";
import { isMac } from "../platform";
import { defaultEvalDefs, buildPresetEvalTemplates } from "../evaluations/presets";
import { buildPresetTodoTemplates } from "../todoTemplates";
import { translate, type TranslationKey } from "../../i18n/messages";
import { DEFAULT_MODELS } from "../ai/providers";
import { DEFAULT_LOCAL_STT_MODEL } from "../transcription/localModels";
import { FALLBACK_STT_PROVIDER } from "../transcription/registry";

/** A translate function bound to a language, for resolving built-in templates. */
export const tFor = (language: AppLanguage) => (key: TranslationKey) => translate(language, key);

// Built-in templates are seeded in the default language; the persist `merge`
// (rehydrate) and `relocalizeBuiltins` (on language change) re-resolve them to
// the active language afterward.
const tDefault = tFor("zh-TW");

/**
 * The push-to-talk trigger a fresh install starts on.
 *
 * macOS gets ⌥ Space, which is free there. On Windows Alt+Space is the native
 * window system menu — registering it would either fail or steal a chord every
 * Windows user already has muscle memory for — so the Windows default is
 * Ctrl+Alt+Space, which nothing in the shell claims.
 *
 * Only the DEFAULT is platform-dependent. `voiceTypingShortcut` is persisted,
 * and the persist `merge` spreads the saved settings OVER these defaults, so a
 * trigger the user picked themselves keeps winning after an update.
 */
export const DEFAULT_VOICE_TYPING_SHORTCUT: Settings["voiceTypingShortcut"] = isMac()
  ? "alt-space"
  : "combo:control+alt+Space";

/** Every one-time hint id. Existing users are migrated with all of them seen. */
export const ALL_HINT_IDS: readonly HintId[] = [
  "report.filing",
  "replay.seek",
  "copy.handoff",
  "speakers.whoAmI",
  "home.voiceTyping",
];

/** Fresh checklist: nothing done, not dismissed. Treat as read-only. */
export const DEFAULT_GETTING_STARTED: GettingStartedState = Object.freeze({
  recorded: false,
  filed: false,
  replayed: false,
  handedOff: false,
  dismissedAt: null,
});

export const DEFAULT_SETTINGS: Settings = {
  language: "zh-TW",
  theme: "system",
  layout: "coach",
  onboarded: false,
  onboardingStep: 0,
  onboardingStepId: "",
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
  aiMemoryNotes: "",
  // Default both lanes to Groq's gpt-oss (fast + cheap); switch in Settings.
  llmProviders: { realtime: "groq", deep: "groq" },
  anthropicApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  openrouterApiKey: "",
  groqApiKey: "",
  qwenApiKey: "",
  kimiApiKey: "",
  ollamaApiKey: "",
  parleyApiKey: "",
  customBaseUrl: "",
  customApiKey: "",
  reasoningEffort: { realtime: "low", deep: "medium" },
  models: DEFAULT_MODELS,
  transcriptionProvider: FALLBACK_STT_PROVIDER,
  sonioxApiKey: "",
  deepgramApiKey: "",
  assemblyaiApiKey: "",
  localSttModel: DEFAULT_LOCAL_STT_MODEL,
  localSttModelChosen: false,
  inputDevice: "",
  // Recordings analyze themselves as they always have; turning this off hands
  // analysis to an external AI over MCP. See Settings.autoStudyAnalysis.
  autoStudyAnalysis: true,
  voiceTypingEnabled: true,
  voiceTypingShortcut: DEFAULT_VOICE_TYPING_SHORTCUT,
  voiceTypingMode: "hold",
  voiceTypingPolishStyle: "tidy",
  // The dictation stays on the clipboard. See Settings.voiceTypingRestoreClipboard.
  voiceTypingRestoreClipboard: false,
  evaluations: defaultEvalDefs(tDefault),
  evalTemplates: buildPresetEvalTemplates(tDefault),
  todoTemplates: buildPresetTodoTemplates(tDefault),
  // Pace + pauses are free (timing/DSP) so default on; pitch + tone (LLM cost)
  // are opt-in. See DeliveryToggles.
  delivery: { pace: true, pitch: false, pauses: true, tone: false },
  // Signed-in users sync by default (prior behavior); the toggle lets a user
  // keep this device local-only. Finished meetings save to the personal root.
  syncEnabled: true,
  defaultSaveLocation: { scope: "personal", folderId: null },
  gettingStarted: { ...DEFAULT_GETTING_STARTED },
  hintsSeen: [],
};
