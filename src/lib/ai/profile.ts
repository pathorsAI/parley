import type { Settings } from "../types";

/**
 * A short preamble describing who "ME" is, injected into every meeting prompt
 * (ask / evaluations / todos). Helps the model recognize when the user is
 * speaking or addressed by name — especially under diarization, where speakers
 * arrive as numbers — and tailor guidance to their role.
 */
export function profileContext(settings: Settings): string {
  const parts: string[] = [];
  if (settings.userName.trim()) parts.push(`name: ${settings.userName.trim()}`);
  if (settings.userRole.trim()) parts.push(`role: ${settings.userRole.trim()}`);
  if (settings.userCompany.trim()) parts.push(`company: ${settings.userCompany.trim()}`);
  if (parts.length === 0) return "";
  return (
    `About ME (the person you assist) — ${parts.join(", ")}. ` +
    `Use this to spot when ME is the one speaking or being addressed, and tailor advice to their role.\n\n`
  );
}

/**
 * Instruction forcing user-facing analysis output into the app's configured UI
 * language, independent of the transcript's language — so a user who set the UI
 * to 繁中 doesn't get an English debrief. Append to the system prompt of analysis
 * outputs (debrief / evaluations / timeline). Verbatim transcript quotes stay in
 * their original language.
 */
export function outputLanguageInstruction(settings: Settings): string {
  const lang = settings.language === "zh-TW" ? "Traditional Chinese (繁體中文)" : "English";
  return (
    `\n\nWrite ALL of your prose output (summaries, titles, explanations, advice) in ${lang}, ` +
    `regardless of the language spoken in the transcript. Keep any VERBATIM quotes you cite from ` +
    `the transcript in their original language.`
  );
}
