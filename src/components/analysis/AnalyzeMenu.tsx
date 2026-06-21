import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Activity, ChevronDown, ListChecks, Loader2, Sparkles } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { reanalyzeAll, runAnalysis } from "../../lib/analysis/engine";
import { regenerateActionItems } from "../../lib/analysis/actionItems";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";

/**
 * The single analysis entry point for REPLAY, mounted top-right of the player bar.
 * Replaces the per-panel buttons (timeline "Analyze", action-items "Regenerate")
 * with one menu: re-analyze everything, or just the timeline / just the action
 * items. User-picked runs force a fresh pass (the auto-on-load run uses the cache).
 */
export function AnalyzeMenu() {
  const { t } = useI18n();
  const analysisStatus = useStore((s) => s.analysisStatus);
  const actionItemsStatus = useStore((s) => s.actionItemsStatus);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const busy = analysisStatus === "running" || actionItemsStatus === "running";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={keyMissing}
          title={keyMissing ? t("analyze.noKey") : undefined}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
            "hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {busy ? t("analyze.running") : t("analyze.menu")}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[80] min-w-[210px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item
            icon={<Sparkles className="size-3.5" />}
            label={t("analyze.all")}
            hint={t("analyze.allHint")}
            disabled={busy}
            onSelect={() => void reanalyzeAll()}
          />
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Item
            icon={<Activity className="size-3.5" />}
            label={t("analyze.timeline")}
            disabled={busy}
            onSelect={() => void runAnalysis({ mode: "replay", force: true })}
          />
          <Item
            icon={<ListChecks className="size-3.5" />}
            label={t("analyze.actions")}
            disabled={busy}
            onSelect={() => regenerateActionItems()}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs outline-none",
        "data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
      </span>
    </DropdownMenu.Item>
  );
}
