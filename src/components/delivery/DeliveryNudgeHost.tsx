import { useEffect } from "react";
import { Activity, Gauge, Mic, TriangleAlert, Volume2 } from "lucide-react";
import { useStore } from "../../lib/store";
import type { DeliveryNudgeKind } from "../../lib/types";

/** How long a nudge stays on screen before auto-dismissing. */
const SHOW_MS = 4500;

const ICON: Record<DeliveryNudgeKind, typeof Gauge> = {
  pace: Gauge,
  monotone: Activity,
  steamroll: Mic,
  deadair: Volume2,
  tone: TriangleAlert,
};

/**
 * Renders the single transient delivery nudge (pace / monotone / steamroll /
 * dead-air / tone) as a calm, peripheral pill near the top of the window — the
 * speaker is looking at the other person, not the app, so this is deliberately
 * small, brief, and self-dismissing. Reads `deliveryNudge` from the store, which
 * the coach ({@link useDeliveryCoach}) and the LLM tone check both write to.
 */
export function DeliveryNudgeHost() {
  const nudge = useStore((s) => s.deliveryNudge);
  const clear = useStore((s) => s.clearDeliveryNudge);

  useEffect(() => {
    if (!nudge) return;
    const id = setTimeout(clear, SHOW_MS);
    return () => clearTimeout(id);
  }, [nudge, clear]);

  if (!nudge) return null;
  const Icon = ICON[nudge.kind];
  const warn = nudge.severity === "warn";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-50 flex justify-center">
      <button
        type="button"
        onClick={clear}
        className={`pointer-events-auto flex max-w-[80vw] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-200 ${
          warn
            ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
            : "border-border bg-background/90 text-muted-foreground"
        }`}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{nudge.message}</span>
        {nudge.evidence && (
          <span className="truncate opacity-70">— “{nudge.evidence}”</span>
        )}
      </button>
    </div>
  );
}
