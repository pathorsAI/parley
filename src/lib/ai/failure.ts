import { describeAiError } from "./errors";
import { hasProviderKey } from "./settings";
import { PROVIDER_BY_ID } from "./providers";
import type { LlmWorkload, Settings } from "../types";

/**
 * What actually went wrong with an LLM call, in the terms a user can act on.
 *
 * The AI SDK's own message is written for the developer: Anthropic answers a
 * key with a stray space on the end with the bare string `invalid x-api-key`,
 * which surfaced in the pre-flight coach as "出錯了：AI_APICallError: invalid
 * x-api-key" — a dead end with no way to reach the setting that fixes it. This
 * classifier turns the raw failure into a kind the UI can pair with a hint and
 * an "open Settings" button.
 *
 * `AnalysisErrorDialog` classifies the same way for the analysis pipeline; the
 * regexes here are the shared subset (it keeps two extra kinds — structured
 * output and model availability — that only apply to schema-bound calls).
 */
export type AiFailureKind = "missingKey" | "auth" | "rate" | "model" | "generic";

export interface AiFailure {
  kind: AiFailureKind;
  /** The provider's real message, unwrapped from the SDK's error chain. */
  detail: string;
  /** Display name of the provider serving this workload ("Claude", "Groq", …). */
  providerLabel: string;
  /** True when the failure is fixed in Settings rather than by retrying. */
  fixInSettings: boolean;
}

/** Classify a failed LLM call for `workload` under the current settings. */
export function classifyAiFailure(
  err: unknown,
  settings: Settings,
  workload: LlmWorkload
): AiFailure {
  const provider = settings.llmProviders[workload];
  const providerLabel = PROVIDER_BY_ID[provider]?.label ?? provider;
  const detail = describeAiError(err);
  const kind = kindOf(detail, hasProviderKey(settings, workload));
  return { kind, detail, providerLabel, fixInSettings: kind !== "rate" && kind !== "generic" };
}

function kindOf(message: string, keyConfigured: boolean): AiFailureKind {
  if (!keyConfigured) return "missingKey";
  const m = message.toLowerCase();
  if (/(^|[^a-z])401|unauthorized|invalid.*api|api.*key|x-api-key|authentication|forbidden|403/.test(m)) {
    return "auth";
  }
  if (/429|rate.?limit|quota|too many requests|overloaded|capacity|insufficient_quota/.test(m)) {
    return "rate";
  }
  if (/404|not found|does not exist|unknown model|model.*(unavailable|decommission|unsupported)|unsupported model/.test(m)) {
    return "model";
  }
  return "generic";
}

/** The i18n key for this failure's one-line, actionable hint. */
export const AI_FAILURE_HINT_KEY = {
  missingKey: "ai.fail.missingKey",
  auth: "ai.fail.auth",
  rate: "ai.fail.rate",
  model: "ai.fail.model",
  generic: "ai.fail.generic",
} as const satisfies Record<AiFailureKind, string>;
