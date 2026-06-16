import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Evaluation } from "../../lib/types";
import { useI18n } from "../../i18n";
import { Card } from "@/components/ui/card";

const STATUS_DOT: Record<Evaluation["status"], string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-sky-400 animate-pulse",
  ok: "bg-emerald-500",
  flag: "bg-red-500",
  error: "bg-orange-500",
};

const SEVERITY_RING: Record<string, string> = {
  info: "ring-border",
  warn: "ring-amber-500/40",
  critical: "ring-red-500/50",
};

function timeAgo(ts: number | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (!ts) return t("evaluations.notRun");
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return t("evaluations.secondsAgo", { count: secs });
  return t("evaluations.minutesAgo", { count: Math.round(secs / 60) });
}

export function EvaluationCard({ evaluation }: { evaluation: Evaluation }) {
  const { t } = useI18n();
  const { status, result } = evaluation;
  const [open, setOpen] = useState(false);
  const ring =
    status === "flag" && result ? SEVERITY_RING[result.severity] ?? "ring-border" : "ring-transparent";
  const hasWhy = !!result && result.evidence.length > 0;

  return (
    <Card className={`gap-0 p-3 ring-1 ${ring}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1 size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-tight">{evaluation.name}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{evaluation.description}</div>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{timeAgo(evaluation.lastRunAt, t)}</span>
      </div>

      {result && (
        <div className="mt-2.5 border-t pt-2">
          {/* Summary + a "why" toggle that reveals the supporting evidence. */}
          <button
            type="button"
            onClick={() => hasWhy && setOpen((o) => !o)}
            className={`flex w-full items-start gap-1 text-left ${hasWhy ? "cursor-pointer" : "cursor-default"}`}
          >
            {hasWhy && (
              <ChevronRight className={`mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
            )}
            <p className="text-xs leading-relaxed text-foreground/90">{result.summary}</p>
          </button>

          {hasWhy && open && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.evidence.map((ev, i) => (
                <li key={i} className="rounded-md bg-muted/60 px-2 py-1.5 text-[11px]">
                  <span className={`mr-1 font-medium ${ev.source === "me" ? "text-sky-400" : "text-amber-400"}`}>
                    {ev.source === "me" ? t("speaker.you") : t("speaker.them")}:
                  </span>
                  <span className="text-muted-foreground">“{ev.quote}”</span>
                  <div className="mt-0.5 text-muted-foreground/80">{ev.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
