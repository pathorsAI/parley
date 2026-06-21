import { Loader2 } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Severity } from "../../lib/types";

const SEVERITY_DOT: Record<Severity, string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/**
 * REPLAY post-meeting action items: AI-generated follow-ups, each linked back to
 * the moment that motivated it. Auto-generated once analysis finishes (see
 * useReplayAnalysis); read-only with a done-toggle. Regenerating is driven from
 * the player's Analyze menu, not a per-panel button. `onSeek` jumps the audio to
 * a linked moment.
 */
export function ActionItemsPanel({ onSeek }: { onSeek: (ms: number) => void }) {
  const { t } = useI18n();
  const items = useStore((s) => s.actionItems);
  const status = useStore((s) => s.actionItemsStatus);
  const error = useStore((s) => s.actionItemsError);
  const toggle = useStore((s) => s.toggleActionItem);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const running = status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 py-3">
          {keyMissing && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t("actionItems.noKey")}</p>
          )}
          {!keyMissing && running && (
            <p className="flex items-center justify-center gap-1.5 px-1 pt-4 text-center text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("actionItems.generating")}
            </p>
          )}
          {!keyMissing && status === "error" && (
            <p className="px-1 text-xs text-orange-500">{t("actionItems.failed", { error: error ?? "—" })}</p>
          )}
          {!keyMissing && status !== "error" && items.length === 0 && !running && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t("actionItems.empty")}</p>
          )}

          {items.map((a) => (
            <div key={a.id} className="rounded-lg border px-2.5 py-2">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={a.done}
                  onChange={() => toggle(a.id)}
                  className="mt-0.5 size-3.5 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-xs font-medium", a.done && "text-muted-foreground line-through")}>
                    {a.text}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{a.rationale}</span>
                  {a.atMs !== null && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        onSeek(a.atMs!);
                      }}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      <span className={cn("size-2 rounded-full", a.severity ? SEVERITY_DOT[a.severity] : "bg-muted-foreground")} />
                      <span className="font-mono tabular-nums">{formatClock(a.atMs)}</span>
                    </button>
                  )}
                </span>
              </label>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
