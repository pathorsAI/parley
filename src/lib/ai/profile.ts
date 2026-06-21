import type { Settings } from "../types";

/**
 * A preamble describing who "ME / US" is, injected into every meeting prompt
 * (ask / evaluations / todos / timeline / action items / solutions). Beyond
 * tailoring advice, it pins down WHICH SIDE the user is on so the model stops
 * attributing the other party's words, concessions, or demands to the user —
 * especially under diarization, where speakers arrive as bare numbers.
 */
export function profileContext(settings: Settings): string {
  const facts: string[] = [];
  if (settings.userName.trim()) facts.push(`- Name: ${settings.userName.trim()}`);
  if (settings.userRole.trim()) facts.push(`- Role: ${settings.userRole.trim()}`);
  if (settings.userCompany.trim()) facts.push(`- Company / side: ${settings.userCompany.trim()}`);
  if (settings.userBackground?.trim()) facts.push(`- Background: ${settings.userBackground.trim()}`);
  if (facts.length === 0) return "";
  return (
    `ABOUT ME / US (the side you are advising):\n${facts.join("\n")}\n\n` +
    `In the transcript, the speaker matching the name/role/company above is ME / US (my side); ` +
    `everyone else is the OTHER PARTY ("them"). Attribute every statement, question, concession, ` +
    `and demand to the correct side — never mistake the other party's words for mine. If it is ` +
    `genuinely unclear which side a speaker is on, say so rather than guessing.\n\n`
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
