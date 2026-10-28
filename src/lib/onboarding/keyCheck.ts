import type { Settings } from "../types";
import type { TranslationKey } from "../../i18n/messages";
import { PROVIDER_BY_ID } from "../ai/providers";
import { runConnectionTest, type ConnectionErrorMessage } from "../ai/connectionTest";
import { STT_BY_ID } from "../transcription/registry";
import { sttApiKey } from "../transcription/providers";
import * as ipc from "../ipc/commands";

/**
 * The model step's Next: before moving on, make sure the keys the user typed
 * are ones the vendors accept, so a typo surfaces here rather than as a
 * meeting that never transcribes. Only a clear "no" stops them — being
 * offline, a timeout or an odd answer lets them through.
 */

/** What to show under each field; absent = nothing wrong found. */
export interface KeyProblems {
  stt?: ConnectionErrorMessage;
  llm?: ConnectionErrorMessage;
}

/**
 * Does this LLM test failure mean the setup is wrong (rather than "couldn't
 * tell")? A refused key, a 404 or an unknown model always does. An unreachable
 * server only does for an endpoint the user typed in themselves — for the big
 * providers it just means no network right now.
 */
export function llmFailureBlocks(key: TranslationKey, userSuppliedEndpoint: boolean): boolean {
  if (key === "settings.provider.test.unreachable") return userSuppliedEndpoint;
  return (
    key === "settings.provider.test.rejectedKey" ||
    key === "settings.provider.test.notFound" ||
    key === "settings.provider.test.unknownModel"
  );
}

/** Whether the chosen LLM has something filled in worth testing. */
export function llmConfigured(settings: Settings): boolean {
  const llm = PROVIDER_BY_ID[settings.llmProviders.deep];
  if (llm.requiresAccount) return false; // Parley's own: the session is the credential.
  if (llm.userSuppliedBaseUrl) return settings.customBaseUrl.trim() !== "";
  if (llm.requiresKey === false) return false;
  return String(settings[llm.apiKeyField] ?? "").trim() !== "";
}

/** Check the transcription key and (if filled in) the AI key, side by side. */
export async function checkModelKeys(settings: Settings): Promise<KeyProblems> {
  const problems: KeyProblems = {};
  const stt = STT_BY_ID[settings.transcriptionProvider];
  const llm = PROVIDER_BY_ID[settings.llmProviders.deep];
  await Promise.all([
    stt.credential === "apiKey"
      ? ipc
          .verifySttKey({ provider: stt.id, key: sttApiKey(settings, stt.id) })
          .then((verdict) => {
            if (verdict === "rejected") {
              problems.stt = { key: "onboarding.model.sttKeyRejected", vars: { provider: stt.label } };
            }
          })
          .catch(() => {
            /* the check itself failed (no backend in a plain browser): can't tell */
          })
      : null,
    llmConfigured(settings)
      ? runConnectionTest(settings, "deep").then((result) => {
          if (!result.ok && llmFailureBlocks(result.error.key, !!llm.userSuppliedBaseUrl)) problems.llm = result.error;
        })
      : null,
  ]);
  return problems;
}
