import { Clock, Loader2 } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { useStudyArtifactDisplay } from "../../lib/analysis/studyPipeline";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
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
  // "queued" = still idle, but the findings pass it waits on is coming — the
  // empty message would be a lie until that pass settles.
  const display = useStudyArtifactDisplay("actions");
  const running = status === "running";
  const pending = running || display === "queued";

  const body = (
    // `relative` anchors the status hint below, which hangs off the bottom edge
    // so it never adds or removes height as the list fills in.
    <div className={`relative flex flex-col ${embedded ? "" : "px-3 pb-8 pt-3"}`}>
          {/* A missing key only matters while there is nothing to show — a
              saved (or prewritten) checklist reads fine without one. */}
          {gate && items.length === 0 && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t(gate)}</p>
          )}
          {/* Rows in the checklist's own shape until the first item streams in;
              after that the items render live. */}
          {!gate && pending && items.length === 0 && <ActionItemSkeletonRows />}
          {!gate && status === "error" && (
            <p className="px-1 text-xs text-destructive">{t("actionItems.failed", { error: error ?? "—" })}</p>
          )}
          {!gate && status !== "error" && items.length === 0 && !pending && (
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

      {/* Queued / still streaming. Absolutely placed in the gap under the list
          (the report's section spacing, or the scroller's bottom padding), so it
          comes and goes without moving anything. */}
      {!gate && pending && (
        <output
          className={`absolute flex items-center gap-1.5 text-[11px] text-muted-foreground ${
            embedded ? "left-1 top-full pt-1" : "bottom-2 left-4"
          }`}
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : <Clock className="size-3" />}
          {running ? t("actionItems.generating") : t("actionItems.queued")}
        </output>
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

/** Placeholder rows matching a real item — checkbox, a line of text, the small
 *  timestamp chip under it — with the same padding and dividers. */
function ActionItemSkeletonRows() {
  return (
    <div aria-hidden="true">
      {["w-4/5", "w-3/5", "w-2/3"].map((w) => (
        <div key={w} className="border-b border-border px-1 py-2.5 last:border-b-0">
          <div className="flex items-start gap-2">
            <Skeleton className="mt-0.5 size-3.5 shrink-0 rounded-sm" />
            <span className="min-w-0 flex-1">
              <Skeleton className={`my-px h-3.5 ${w}`} />
              <Skeleton className="mt-1.5 h-3.5 w-12 rounded-full" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
