import { AlertTriangle, RefreshCw, Settings, X } from "lucide-react";
import { useStore } from "../lib/store";
import { hasProviderKey } from "../lib/ai/settings";
import { PROVIDER_BY_ID } from "../lib/ai/providers";
import { openSettingsWindow } from "../lib/settingsSync";
import { runAllEvaluations } from "../lib/evaluations/engine";
import { reanalyzeTimeline } from "./replay/useTimelineAnalysis";
import { useI18n } from "../i18n";

/**
 * A modal that surfaces a FAILED AI analysis (the "Run all" evaluations or the
 * replay timeline) with the real error and an actionable hint — so a failure
 * isn't a silent "—". Both analyses route through the eval model, so a key/model
 * problem there breaks both while Ask (a different model, no structured output)
 * still works. Strings are kept local (bilingual) so this component is
 * self-contained.
 */

type Kind = "missingKey" | "auth" | "model" | "rate" | "structured" | "generic";

/** Classify the raw error message into an actionable kind. */
function classify(message: string, keyConfigured: boolean): Kind {
  const m = message.toLowerCase();
  if (!keyConfigured) return "missingKey";
  if (/(^|[^a-z])401|unauthorized|invalid.*api|api.*key|authentication|forbidden|403/.test(m))
    return "auth";
  if (/429|rate.?limit|quota|too many requests|overloaded|capacity|insufficient_quota/.test(m))
    return "rate";
  if (/no object generated|did not match|schema|response_format|tool[_ ]?call|structured|json/.test(m))
    return "structured";
  if (/404|not found|does not exist|unknown model|model.*(unavailable|decommission|unsupported)|unsupported model/.test(m))
    return "model";
  return "generic";
}

const HINTS: Record<"zh-TW" | "en", Record<Kind, string>> = {
  "zh-TW": {
    missingKey: "目前這個供應商沒有 API 金鑰。請到設定填入金鑰後再試一次。",
    auth: "API 金鑰無效或沒有權限（401/403）。請到設定確認金鑰是否正確、是否有這個模型的權限。",
    model: "這個模型不可用或不存在。請到設定把「評估模型」換成可用的模型。",
    rate: "達到速率或額度限制。稍等一下再試，或在設定換成別的模型／供應商。",
    structured:
      "這個模型可能不支援結構化輸出（評估與時間軸分析都需要）。建議在設定把「評估模型」換成支援的（例如 Claude、OpenAI、OpenRouter 的模型）。",
    generic: "請看下方錯誤訊息；多半可在設定調整供應商、金鑰或模型後解決。",
  },
  en: {
    missingKey: "No API key for this provider. Add one in Settings and try again.",
    auth: "API key is invalid or lacks access (401/403). Check the key and model access in Settings.",
    model: "This model is unavailable or doesn't exist. Switch the eval model in Settings.",
    rate: "Hit a rate or quota limit. Wait and retry, or switch model/provider in Settings.",
    structured:
      "This model may not support structured output (evaluations + timeline need it). Switch the eval model in Settings to one that does (e.g. Claude, OpenAI, or an OpenRouter model).",
    generic: "See the error below — usually fixable by adjusting the provider, key, or model in Settings.",
  },
};

const LABELS = {
  "zh-TW": { title: "分析失敗", provider: "供應商", model: "評估模型", openSettings: "開啟設定", dismiss: "關閉", retry: "重試" },
  en: { title: "Analysis failed", provider: "Provider", model: "Eval model", openSettings: "Open Settings", dismiss: "Dismiss", retry: "Retry" },
} as const;

export function AnalysisErrorDialog() {
  const { language } = useI18n();
  const lang = language === "en" ? "en" : "zh-TW";

  const evalError = useStore((s) => s.evalError);
  const timelineError = useStore((s) => s.replayTimelineError);
  const timelineStatus = useStore((s) => s.replayTimelineStatus);
  const provider = useStore((s) => s.settings.provider);
  const evalModel = useStore((s) => s.settings.models[s.settings.provider].eval);
  const keyConfigured = useStore((s) => hasProviderKey(s.settings));
  const setEvalError = useStore((s) => s.setEvalError);
  const setReplayTimelineError = useStore((s) => s.setReplayTimelineError);

  // Prefer the eval error, then a failed timeline run.
  const message = evalError ?? (timelineStatus === "error" ? timelineError : null);
  if (!message) return null;

  const L = LABELS[lang];
  const kind = classify(message, keyConfigured);
  const hint = HINTS[lang][kind];

  function dismiss() {
    setEvalError(null);
    setReplayTimelineError(null);
  }

  /** Re-run whichever analysis failed, then close. */
  function retry() {
    const wasEval = evalError != null;
    dismiss();
    if (wasEval) void runAllEvaluations();
    else reanalyzeTimeline();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={dismiss}>
      <div
        className="flex w-full max-w-md flex-col rounded-xl border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <AlertTriangle className="size-4 text-orange-500" />
          <span className="text-sm font-semibold">{L.title}</span>
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={dismiss}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3.5">
          <p className="text-[13px] leading-relaxed text-foreground/90">{hint}</p>

          <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium">{L.provider}:</span> {PROVIDER_BY_ID[provider]?.label ?? provider}
            <span className="mx-1.5 opacity-40">·</span>
            <span className="font-medium">{L.model}:</span> <span className="font-mono">{evalModel}</span>
          </div>

          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">{message.slice(0, 80)}{message.length > 80 ? "…" : ""}</summary>
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 text-[10px] leading-snug text-foreground/80">
              {message}
            </pre>
          </details>

          <div className="flex justify-end gap-2 pt-0.5">
            <button
              type="button"
              onClick={dismiss}
              className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {L.dismiss}
            </button>
            <button
              type="button"
              onClick={retry}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
            >
              <RefreshCw className="size-3.5" />
              {L.retry}
            </button>
            <button
              type="button"
              onClick={() => {
                void openSettingsWindow();
                dismiss();
              }}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Settings className="size-3.5" />
              {L.openSettings}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
