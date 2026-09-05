import { toast } from "sonner";
import { translate } from "../../i18n/messages";
import { useStore } from "../store";
import { openSettings } from "../nav/settings";
import { log } from "../log";
import { AI_FAILURE_HINT_KEY, classifyAiFailure } from "./failure";
import type { LlmWorkload } from "../types";

/**
 * Report a failed LLM call as something the user can act on: the actionable
 * line as the toast title, the provider's real message as the description, and
 * — when the fix lives in Settings — a button that goes straight there.
 *
 * Replaces `toast.error(t("...failed", { error: String(e) }))`, which rendered
 * the SDK's developer-facing string ("AI_APICallError: invalid x-api-key") with
 * nowhere to go from it.
 */
export function toastAiFailure(scope: string, err: unknown, workload: LlmWorkload): void {
  const { settings } = useStore.getState();
  const failure = classifyAiFailure(err, settings, workload);
  log.error(`${scope}: failed`, {
    kind: failure.kind,
    provider: failure.providerLabel,
    workload,
    error: failure.detail,
  });
  const lang = settings.language;
  toast.error(
    translate(lang, AI_FAILURE_HINT_KEY[failure.kind], { provider: failure.providerLabel }),
    {
      description: failure.detail,
      duration: 8000,
      action: failure.fixInSettings
        ? { label: translate(lang, "ai.fail.openSettings"), onClick: () => openSettings() }
        : undefined,
    }
  );
}
