import { Mic } from "lucide-react";
import { useI18n } from "../../i18n";
import { formatLongDuration, type ImportDecision } from "../../lib/replay/split";
import type { AppLanguage } from "../../lib/types";
import { fileNameOf } from "../../lib/replay/ingest";

/** The wizard's first-step notice for a file that cannot go up as picked:
 *  refused outright, or long enough that hosted transcription splits it. */
export function ImportGateNotice({
  decision,
  path,
  language,
}: Readonly<{
  decision: ImportDecision | null;
  path: string | null;
  language: AppLanguage;
}>) {
  const { t } = useI18n();
  if (decision?.kind === "refuse") {
    return (
      <div className="flex items-start gap-2 rounded-md bg-danger px-3 py-2.5 text-[12px] text-danger-foreground">
        <Mic className="mt-0.5 size-4 shrink-0" />
        <span>{t(decision.key)}</span>
      </div>
    );
  }
  if (decision?.kind !== "split") return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
      <span className="text-sm font-medium text-foreground">
        {t("ingest.split.title", { n: decision.plan.parts })}
      </span>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {t("ingest.split.body", {
          n: decision.plan.parts,
          duration: formatLongDuration(decision.durationSeconds, language),
          partDuration: formatLongDuration(decision.plan.partSeconds, language),
          name: path ? fileNameOf(path) : "",
        })}
      </p>
    </div>
  );
}
