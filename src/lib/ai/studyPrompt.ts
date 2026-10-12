// THE study-pipeline prompts — meeting kind, timeline findings, action items,
// brief, delivery — and the built-in evaluation presets, for every Parley
// client. Android reads a generated copy of this same file
// (scripts/gen-study-prompt.mjs), so a wording change lands on both at once and
// a recording gets the same analysis whichever device ran it.
//
// tests/studyPrompts.test.ts pins what the desktop composes from it, and writes
// shared/prompts/study.golden.json, which Android's StudyPromptsGoldenTest
// replays to prove the phone composes the same prompts.
import STUDY_JSON from "../../../shared/prompts/study.json";

export const STUDY = STUDY_JSON;

/**
 * Fill every `{{name}}` placeholder in ONE pass — a value that itself contains
 * `{{…}}` is inserted verbatim, never expanded. Throws on a placeholder with no
 * value, so a renamed placeholder in the JSON fails loudly instead of shipping
 * a literal `{{name}}` to the model.
 */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`study prompt: no value for {{${key}}}`);
    return value;
  });
}

/** The "Meeting context: …" paragraph of a user prompt, or "" when there is none. */
export function meetingContextBlock(meetingContext: string | undefined): string {
  const ctx = meetingContext?.trim();
  return ctx ? `${STUDY.meetingContextPrefix}${ctx}\n\n` : "";
}
