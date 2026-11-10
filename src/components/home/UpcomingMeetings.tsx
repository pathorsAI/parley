import { Plus } from "lucide-react";
import { useStore } from "../../lib/store";
import { isStartingSoon, sortDrafts, type MeetingDraft } from "../../lib/store/prep";
import { useI18n } from "../../i18n";
import { DraftRow, useNow } from "./DraftRow";

type FolderName = (id: string | null) => string | undefined;

/** The saved drafts split the way 總覽 shows them: the meetings starting
 *  within the hour (or under way), and every other draft. Both soonest first. */
function useDraftSplit(): { now: number; soon: MeetingDraft[]; rest: MeetingDraft[] } {
  const drafts = useStore((s) => s.drafts);
  const now = useNow();
  const sorted = sortDrafts(drafts, now);
  return {
    now,
    soon: sorted.filter((d) => isStartingSoon(d, now)),
    rest: sorted.filter((d) => !isStartingSoon(d, now)),
  };
}

function DraftList({
  rows,
  now,
  folderName,
  empty,
}: Readonly<{ rows: MeetingDraft[]; now: number; folderName: FolderName; empty: string }>) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-white/20 dark:bg-black/10 px-4 py-5 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((d) => (
        <DraftRow key={d.id} draft={d} now={now} folder={folderName(d.meetingFolderId)} />
      ))}
    </ul>
  );
}

function Heading({ title, count, action }: Readonly<{ title: string; count: number; action?: React.ReactNode }>) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <h2 className="text-xs font-semibold text-muted-foreground">{title}</h2>
      {count > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>}
      {action}
    </div>
  );
}

/**
 * 總覽's top block, 即將開始的會議: the drafted meetings that start within the
 * next hour, or have started and not yet ended — the ones to act on now. A
 * meeting moves here from 會議草稿 an hour before its time.
 */
export function StartingSoon({ folderName, style }: Readonly<{ folderName: FolderName; style?: React.CSSProperties }>) {
  const { t } = useI18n();
  const { now, soon } = useDraftSplit();
  return (
    <section className="animate-fade-up flex flex-col gap-1.5" style={style}>
      <Heading title={t("home.soon.title")} count={soon.length} />
      <DraftList rows={soon} now={now} folderName={folderName} empty={t("home.soon.empty")} />
    </section>
  );
}

/**
 * 總覽's 會議草稿: every other saved draft — later today, another day, or with
 * no time yet — soonest first, each one click from editing or recording.
 * Always shown, so the place to find a prepared meeting is never a guess.
 */
export function MeetingDrafts({ folderName, style }: Readonly<{ folderName: FolderName; style?: React.CSSProperties }>) {
  const { t } = useI18n();
  const { now, rest } = useDraftSplit();
  return (
    <section className="animate-fade-up flex min-w-0 flex-col gap-1.5" style={style}>
      <Heading
        title={t("library.org.drafts")}
        count={rest.length}
        action={
          <button
            type="button"
            onClick={() => useStore.getState().setDraftOpen(true)}
            className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-primary transition-colors hover:text-primary/80"
          >
            <Plus className="size-3" />
            {t("home.newDraft")}
          </button>
        }
      />
      <DraftList rows={rest} now={now} folderName={folderName} empty={t("home.upcoming.empty")} />
    </section>
  );
}
