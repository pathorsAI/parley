import { RefreshCw } from "lucide-react";
import type { Evaluation } from "../../lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

function timeAgo(ts?: number) {
  if (!ts) return "never run";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

export function EvaluationCard({
  evaluation,
  onRerun,
}: {
  evaluation: Evaluation;
  onRerun: (id: string) => void;
}) {
  const { status, result } = evaluation;
  const ring =
    status === "flag" && result ? SEVERITY_RING[result.severity] ?? "ring-border" : "ring-transparent";

  return (
    <Card className={`gap-0 p-3 ring-1 ${ring}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className={`mt-1 size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
          <div>
            <div className="text-sm font-medium leading-tight">{evaluation.name}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{evaluation.description}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          disabled={status === "running"}
          onClick={() => onRerun(evaluation.id)}
          title="Rerun"
        >
          <RefreshCw className={`size-3 ${status === "running" ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {result && (
        <div className="mt-2.5 border-t pt-2">
          <p className="text-xs leading-relaxed text-foreground/90">{result.summary}</p>
          {result.evidence.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.evidence.map((ev, i) => (
                <li key={i} className="rounded-md bg-muted/60 px-2 py-1.5 text-[11px]">
                  <span className={`mr-1 font-medium ${ev.source === "me" ? "text-sky-400" : "text-amber-400"}`}>
                    {ev.source === "me" ? "You" : "Them"}:
                  </span>
                  <span className="text-muted-foreground">“{ev.quote}”</span>
                  <div className="mt-0.5 text-muted-foreground/80">{ev.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>{evaluation.mode === "auto" ? `auto · every ${evaluation.autoEverySec}s` : "manual"}</span>
        <span>{timeAgo(evaluation.lastRunAt)}</span>
      </div>
    </Card>
  );
}
