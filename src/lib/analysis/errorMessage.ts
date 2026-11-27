import { useStore } from "../store";

/**
 * The message a study stage shows for a failed pass. A timeout (our own
 * deadline — see ai/deadline.ts), a provider refusing the user's region, and
 * hosted credit/auth exhaustion get their own copy; everything else falls back to the raw provider error. Shared by the
 * runners so a hung model call reads the same on every stage.
 */
export async function studyErrorMessage(err: unknown, provider: string): Promise<string> {
  const { describeAiError, hostedLlmErrorCode, isTimeoutError } = await import("../ai/errors");
  const { translate } = await import("../../i18n/messages");
  const { isRegionRefusalError } = await import("../ai/region");
  const { PROVIDER_BY_ID } = await import("../ai/providers");
  const lang = useStore.getState().settings.language;
  if (isTimeoutError(err)) return translate(lang, "analysis.error.timeout");
  // A BYOK provider that refuses the user's region (HK / mainland China): say
  // so, instead of the provider's 403 that reads like a key problem.
  if (isRegionRefusalError(err, provider)) {
    const label = PROVIDER_BY_ID[provider as keyof typeof PROVIDER_BY_ID]?.label ?? provider;
    return translate(lang, "ai.fail.regionUnsupported", { provider: label });
  }
  const code = hostedLlmErrorCode(err, provider);
  if (code === "credits") return translate(lang, "analysis.error.credits");
  if (code === "auth") return translate(lang, "analysis.error.auth");
  if (code === "busy") return translate(lang, "analysis.error.busy");
  return describeAiError(err);
}
