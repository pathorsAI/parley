import { useStore } from "../store";

/**
 * The message a study stage shows for a failed pass. A timeout (our own
 * deadline — see ai/deadline.ts) and hosted credit/auth exhaustion get their
 * own copy; everything else falls back to the raw provider error. Shared by the
 * runners so a hung model call reads the same on every stage.
 */
export async function studyErrorMessage(err: unknown, provider: string): Promise<string> {
  const { describeAiError, hostedLlmErrorCode, isTimeoutError } = await import("../ai/errors");
  const { translate } = await import("../../i18n/messages");
  const lang = useStore.getState().settings.language;
  if (isTimeoutError(err)) return translate(lang, "analysis.error.timeout");
  const code = hostedLlmErrorCode(err, provider);
  if (code === "credits") return translate(lang, "analysis.error.credits");
  if (code === "auth") return translate(lang, "analysis.error.auth");
  return describeAiError(err);
}
