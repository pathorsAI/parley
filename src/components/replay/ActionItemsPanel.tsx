import { useMemo } from "react";
import { Clock, Loader2 } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { useStudyArtifactDisplay } from "../../lib/analysis/studyPipeline";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { listLocalFolders } from "../../lib/history/folders";
import {
  distinctOwners,
  groupActionItemsBySide,
  type ActionItemGroup,
} from "../../lib/analysis/actionItemSides";
import { ownerDisplayName } from "../../lib/speakers/owners";
import { useRelabel, useSpeakerLabel } from "../../lib/speakers/useRelabel";
import { useI18n } from "../../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ActionItem, Severity } from "../../lib/types";

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
 *
 * Items that say whose they are (`side`) render in two groups — our side first,
 * then the other party. The page header's 複製後續行動 copies both lists as
 * text (useHandoff's studyPageTextFromState). Items with no side (older
 * recordings) keep the one flat list.
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
  const stored = useStore((s) => s.actionItems);
  const segments = useStore((s) => s.segments);
  const speakerNames = useStore((s) => s.speakerNames);
  const label = useSpeakerLabel();
  const relabel = useRelabel();
  // Owners read by the speakers' current names, so renaming a speaker in the
  // transcript renames every follow-up it owns (rows, group header, copy). The
  // item text cites speakers too — by the names they had when it was written.
  const items = useMemo(
    () =>
      stored.map((a) => {
        const resolved = ownerDisplayName(a, segments, speakerNames, label);
        const owner = resolved === a.owner && resolved ? relabel(resolved) : resolved;
        const text = relabel(a.text);
        return owner === a.owner && text === a.text ? a : { ...a, owner, text };
      }),
    [stored, segments, speakerNames, label, relabel],
  );
  const status = useStore((s) => s.actionItemsStatus);
  const error = useStore((s) => s.actionItemsError);
  // null = configured. Otherwise the i18n key naming what's still missing.
  const gate = useStore((s) =>
    providerGateKey(missingProviderRequirement(s.settings, "deep"), "actionItems.noKey")
  );
  // "queued" = still idle, but the findings pass it waits on is coming — the
  // empty message would be a lie until that pass settles.
  const display = useStudyArtifactDisplay("actions");
  const running = status === "running";
  const pending = running || display === "queued";
  const groups = groupActionItemsBySide(items);
  // Our side is the user's company; theirs is the folder the recording is filed
  // in (folders are per customer / deal). Either falls back to a plain "us" /
  // "them" when unknown.
  const userCompany = useStore((s) => s.settings.userCompany.trim());
  const folderId = useStore((s) => s.replayFolderId);
  const folderName =
    groups && folderId ? (listLocalFolders().find((f) => f.id === folderId)?.name.trim() ?? "") : "";
  const sideNames = { us: userCompany, them: folderName };

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

          {groups
            ? groups.map((g) => (
                <ActionItemGroupSection key={g.side} group={g} sideName={sideNames[g.side]} onSeek={onSeek} />
              ))
            : items.map((a) => <ActionItemRow key={a.id} item={a} onSeek={onSeek} />)}

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

/** One action item: done toggle, text (+ owner), and the seekable timestamp. */
function ActionItemRow({ item: a, onSeek }: Readonly<{ item: ActionItem; onSeek: (ms: number) => void }>) {
  const toggle = useStore((s) => s.toggleActionItem);
  // Bound to a const so the seek callback keeps the non-null narrowing.
  const atMs = a.atMs;
  return (
    <div className="border-b border-border px-1 py-2.5 last:border-b-0">
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
            {a.owner && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{a.owner}</span>}
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
}

/** One side's items under a header: dot, side name, owners, count. */
function ActionItemGroupSection({
  group,
  sideName,
  onSeek,
}: Readonly<{
  group: ActionItemGroup;
  /** The side's own name (company / folder), or "" when unknown. */
  sideName: string;
  onSeek: (ms: number) => void;
}>) {
  const { t } = useI18n();
  const us = group.side === "us";
  const plainName = sideName || t(us ? "actionItems.side.us" : "actionItems.side.them");
  const label = sideName
    ? t(us ? "actionItems.side.usNamed" : "actionItems.side.themNamed", { name: sideName })
    : plainName;
  const owners = distinctOwners(group.items);

  return (
    <section className="mb-3 last:mb-0">
      <div className="flex items-center gap-2 border-b border-border px-1 pb-1.5 pt-1">
        <span className={cn("size-2 shrink-0 rounded-full", us ? "bg-primary" : "bg-muted-foreground/60")} />
        <span className="min-w-0 truncate text-xs font-semibold">{label}</span>
        {owners.length > 0 && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {owners.join(t("actionItems.side.ownerJoiner"))}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {t("actionItems.side.count", { n: group.items.length })}
        </span>
      </div>
      {group.items.map((a) => (
        <ActionItemRow key={a.id} item={a} onSeek={onSeek} />
      ))}
    </section>
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
