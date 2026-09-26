import { Loader2 } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Severity } from "../../lib/types";

const SEVERITY_DOT: Record<Severity, string> = {
  info: "bg-info-foreground",
  warn: "bg-warning-foreground",
  critical: "bg-danger-foreground",
};

/**
 * REPLAY post-meeting action items: AI-generated follow-ups, each linked back to
 * the moment that motivated it. Auto-generated once analysis finishes (see
 * lib/analysis/studyPipeline.ts); read-only with a done-toggle. Regenerating is driven from
 * the titlebar's analysis chip, not a per-panel button. `onSeek` jumps the audio
 * to a linked moment.
 */
export function ActionItemsPanel({
  onSeek,
  embedded = false,
}: Readonly<{
  onSeek: (ms: number) => void;
  /** Render as a plain column (no own scroller) inside an already-scrolling
   *  page, e.g. the study report. */
  embedded?: boolean;
}>) {
  const { t } = useI18n();
  const items = useStore((s) => s.actionItems);
  const status = useStore((s) => s.actionItemsStatus);
  const error = useStore((s) => s.actionItemsError);
  const toggle = useStore((s) => s.toggleActionItem);
  // null = configured. Otherwise the i18n key naming what's still missing.
  const gate = useStore((s) =>
    providerGateKey(missingProviderRequirement(s.settings, "deep"), "actionItems.noKey")
  );
  const running = status === "running";

  const body = (
    <div className={`flex flex-col ${embedded ? "" : "px-3 py-3"}`}>
          {/* A missing key only matters while there is nothing to show — a
              saved (or prewritten) checklist reads fine without one. */}
          {gate && items.length === 0 && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t(gate)}</p>
          )}
          {/* Centered spinner only until the first item streams in; after that the
              items render live and a slim footer hint shows it's still going. */}
          {!gate && running && items.length === 0 && (
            <p className="flex items-center justify-center gap-1.5 px-1 pt-4 text-center text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("actionItems.generating")}
            </p>
          )}
          {!gate && status === "error" && (
            <p className="px-1 text-xs text-destructive">{t("actionItems.failed", { error: error ?? "—" })}</p>
          )}
          {!gate && status !== "error" && items.length === 0 && !running && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t("actionItems.empty")}</p>
          )}

          {items.map((a) => {
            // Bound to a const so the seek callback keeps the non-null narrowing.
            const atMs = a.atMs;
            return (
            <div key={a.id} className="border-b border-border px-1 py-2.5 last:border-b-0">
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
                  {atMs !== null && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        onSeek(atMs);
                      }}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      <span className={cn("size-2 rounded-full", a.severity ? SEVERITY_DOT[a.severity] : "bg-muted-foreground")} />
                      <span className="tabular-nums">{formatClock(atMs)}</span>
                    </button>
                  )}
                </span>
              </label>
            </div>
            );
          })}

      {/* Still streaming, but rows are already showing. */}
      {!gate && running && items.length > 0 && (
        <p className="flex items-center gap-1.5 px-1 pt-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t("actionItems.generating")}
        </p>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
    </div>
  );
}
