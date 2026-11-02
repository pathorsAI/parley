import { Plus } from "lucide-react";
import { useStore } from "../../lib/store";
import { draftsForOrg, sortDrafts } from "../../lib/store/prep";
import { useI18n } from "../../i18n";
import { DraftRow, useNow } from "../home/DraftRow";
import { EmptyRecords } from "./EmptyRecords";

/**
 * An org's 會議草稿: the saved drafts headed for this org — its root or one
 * of its folders — in 即將開始's order and row. They are the same drafts
 * 總覽 lists, read off the one store, so an edit on either page shows on both.
 */
export function OrgMeetingDrafts({
  orgId,
  folders,
}: Readonly<{ orgId: string; folders: readonly { id: string; name: string }[] }>) {
  const { t } = useI18n();
  const drafts = useStore((s) => s.drafts);
  const now = useNow();
  const rows = sortDrafts(draftsForOrg(drafts, orgId));

  const folderName = (d: (typeof rows)[number]) => {
    const share = d.meetingOrgShare;
    const id = typeof share === "object" ? share?.folderId : null;
    return id ? folders.find((f) => f.id === id)?.name : undefined;
  };

  return (
    <section className="min-w-0">
      <div className="flex items-center px-2 pt-6 pb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("library.org.drafts")}
          {rows.length > 0 && <span className="ml-1.5 font-normal tabular-nums">{rows.length}</span>}
        </h2>
        <button
          type="button"
          onClick={() => useStore.getState().setDraftOpen(true, { orgId, folderId: null })}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="size-3" />
          {t("home.newDraft")}
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyRecords title={t("library.org.draftsEmptyTitle")} hint={t("library.org.draftsEmpty")} compact />
      ) : (
        <ul className="flex flex-col">
          {rows.map((d) => (
            <DraftRow key={d.id} draft={d} now={now} folder={folderName(d)} />
          ))}
        </ul>
      )}
    </section>
  );
}
