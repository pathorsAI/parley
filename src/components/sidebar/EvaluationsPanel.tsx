import { RefreshCw } from "lucide-react";
import { useStore } from "../../lib/store";
import { triggerEvaluation } from "../../lib/evaluations/engine";
import { hasProviderKey } from "../../lib/ai/settings";
import { EvaluationCard } from "./EvaluationCard";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function EvaluationsPanel() {
  const evaluations = useStore((s) => s.evaluations);
  const provider = useStore((s) => s.settings.provider);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
        <span>{evaluations.length} evaluations</span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => evaluations.forEach((e) => void triggerEvaluation(e.id))}
        >
          <RefreshCw className="size-3" />
          Run all
        </Button>
      </div>

      {keyMissing && (
        <div className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          尚未設定 {provider === "anthropic" ? "Claude" : "OpenRouter"} 金鑰，evaluation 無法執行（右上角 ⚙ 設定）。
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {evaluations.map((e) => (
            <EvaluationCard
              key={e.id}
              evaluation={e}
              onRerun={(id) => void triggerEvaluation(id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
