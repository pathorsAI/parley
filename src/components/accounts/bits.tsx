import { Fragment, useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { useI18n } from "../../i18n";
import { useAccounts } from "../../lib/accounts/store";
import { useStageSet } from "../../lib/accounts/useStageSet";
import type { SalesStage } from "../../lib/accounts/types";

/** Tiny shared account-area primitives. */

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
/** Ignore an ingest marker the user only comes back to much later. */
const INGEST_MARKER_TTL_MS = 15 * 60_000;
/** How long freshly landed cards stay highlighted once on screen. */
const INGEST_HIGHLIGHT_MS = 6_000;

/**
 * Claim ids to highlight because they just landed via the review flow (B-9).
 * The first mounted view that sees the marker owns the countdown: highlight
 * for a few seconds, then clear the store marker so it never replays.
 */
export function useRecentIngestHighlight(companyId: string): ReadonlySet<string> {
  const recent = useAccounts((s) => s.recentIngest);
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);

  useEffect(() => {
    if (!recent || recent.companyId !== companyId) {
      setIds(EMPTY_ID_SET);
      return;
    }
    const { clearRecentIngest } = useAccounts.getState();
    if (Date.now() - recent.at > INGEST_MARKER_TTL_MS) {
      clearRecentIngest();
      return;
    }
    setIds(new Set(recent.claimIds));
    const timer = setTimeout(() => {
      setIds(EMPTY_ID_SET);
      clearRecentIngest();
    }, INGEST_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [recent, companyId]);

  return ids;
}

/** Stance as a colored dot: green support, gray neutral/unknown, red oppose. */
export function StanceDot({
  stance,
}: Readonly<{ stance?: "support" | "neutral" | "oppose" }>) {
  const cls =
    stance === "support"
      ? "bg-emerald-500"
      : stance === "oppose"
        ? "bg-red-500"
        : "bg-muted-foreground/40";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

/**
 * Text that IS an input: looks like plain text until hovered/focused, so every
 * name and note stays editable in place without an edit mode. Commits on blur
 * or Enter; Escape restores. Never commits empty when `required`.
 */
export function InlineEdit({
  value,
  onCommit,
  className,
  placeholder,
  required,
}: Readonly<{
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
}>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  function commit() {
    const next = draft.trim();
    if (required && !next) {
      setDraft(value);
      return;
    }
    if (next !== value) onCommit(next);
  }

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={`w-full rounded-md border border-transparent bg-transparent px-1 outline-none transition-colors hover:border-input focus:border-input focus:ring-1 focus:ring-ring ${className ?? ""}`}
    />
  );
}

/** Alias list editor: shown/typed as 「、」-joined text, stored as string[]. */
export function AliasesEdit({
  aliases,
  onCommit,
}: Readonly<{ aliases: string[]; onCommit: (next: string[]) => void }>) {
  const { t } = useI18n();
  return (
    <InlineEdit
      value={aliases.join("、")}
      onCommit={(text) =>
        onCommit(
          text
            .split(/[,、，;；]/)
            .map((a) => a.trim())
            .filter(Boolean)
        )
      }
      placeholder={t("accounts.aliasesPlaceholder")}
      className="h-6 text-xs text-muted-foreground"
    />
  );
}

/**
 * The pipeline as a clickable stepper — the sales mental model is a conveyor
 * (Discovery → … → Closing), not a dropdown. Click a step to move the deal.
 */
export function StageStepper({
  stage,
  onChange,
}: Readonly<{ stage: SalesStage; onChange: (s: SalesStage) => void }>) {
  const set = useStageSet();
  const idx = set.order.indexOf(stage);
  return (
    <div className="flex flex-wrap items-center gap-y-1">
      {set.order.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <div className={`h-px w-3 ${i <= idx ? "bg-sky-500" : "bg-border"}`} />}
          <button
            type="button"
            onClick={() => onChange(s)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              i === idx
                ? "border-sky-500/60 bg-sky-500/15 font-semibold text-sky-700 dark:text-sky-300"
                : i < idx
                  ? "border-transparent bg-muted text-muted-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {set.names[s] ?? s}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/** Compact read-only pipeline position: one dot per stage + the current label. */
export function MiniStages({ stage }: Readonly<{ stage: SalesStage }>) {
  const set = useStageSet();
  const idx = set.order.indexOf(stage);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {set.order.map((s, i) => (
        <span
          key={s}
          className={`size-1.5 rounded-full ${i <= idx ? "bg-sky-500" : "bg-border"}`}
        />
      ))}
      <span className="pl-1 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
        {set.names[stage] ?? stage}
      </span>
    </span>
  );
}

/** Two-step archive button: first click arms it, second click executes. */
export function ArchiveButton({ onArchive }: Readonly<{ onArchive: () => void }>) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => (armed ? onArchive() : setArmed(true))}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
        armed
          ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Archive className="size-3.5" />
      {armed ? t("accounts.archiveConfirm") : t("accounts.archive")}
    </button>
  );
}
