import { Plus } from "lucide-react";
import { useStore } from "../../lib/store";
import { sortDrafts } from "../../lib/store/prep";
import { useI18n } from "../../i18n";
import { DraftRow, useNow } from "./DraftRow";

/**
 * 總覽's 即將開始: every saved meeting draft, soonest first — when, what,
 * which folder, how soon — each one click from editing or recording. Always
 * shown, so the place to find a prepared meeting is never a guess.
 */
export function UpcomingMeetings({
  folderName,
  style,
}: Readonly<{ folderName: (id: string | null) => string | undefined; style?: React.CSSProperties }>) {
  const { t } = useI18n();
  const drafts = useStore((s) => s.drafts);
  const now = useNow();

  const rows = sortDrafts(drafts);

  return (
    <section className="animate-fade-up flex flex-col gap-1.5" style={style}>
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-muted-foreground">{t("home.upcoming.title")}</h2>
        {rows.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{rows.length}</span>}
        <button
          type="button"
          onClick={() => useStore.getState().setDraftOpen(true)}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="size-3" />
          {t("home.newDraft")}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-white/20 px-4 py-5 text-center text-xs text-muted-foreground">
          {t("home.upcoming.empty")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((d) => (
            <DraftRow key={d.id} draft={d} now={now} folder={folderName(d.meetingFolderId)} />
          ))}
        </ul>
      )}
    </section>
  );
}
