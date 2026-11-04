/**
 * Nothing to list: the UX file's empty-box illustration (3541:9456) over a
 * title and a hint. `compact` sits inline under a section heading (an org's
 * drafts, its recordings not in a folder) instead of centring in the whole pane.
 */
export function EmptyRecords({
  title,
  hint,
  compact = false,
}: Readonly<{ title: string; hint: string; compact?: boolean }>) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-1 text-center ${compact ? "py-8" : "h-full"}`}
    >
      <img alt="" src="/library/empty-records.svg" className="mb-4 block h-[105.84px] w-[120px] max-w-none dark:hidden" />
      {/* The same box drawn for the dark theme: slate faces, a navy sheet. */}
      <img alt="" src="/library/empty-records-dark.svg" className="mb-4 hidden h-[105.84px] w-[120px] max-w-none dark:block" />
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="max-w-80 text-xs text-muted-foreground/70">{hint}</p>
    </div>
  );
}
