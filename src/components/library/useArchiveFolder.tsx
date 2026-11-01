import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "../../i18n";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import type { LibraryTree } from "../shell/useLibraryTree";

/**
 * Archiving a personal folder, asked the same way from every door onto it —
 * the library header's 封存資料夾 and the sidebar row's context menu.
 *
 * Archiving loses nothing (the recordings stay, search still finds them), so
 * the question is a plain one, not the red "are you sure" a delete gets; it is
 * asked at all because the folder leaves the sidebar's list, and "where did it
 * go?" deserves an answer before it happens. Restoring is the undo, so it asks
 * nothing and only says where the folder went.
 */
export function useArchiveFolder(tree: LibraryTree): {
  /** Ask before archiving this folder. */
  requestArchive: (folder: LocalFolder) => void;
  /** Bring an archived folder back into the list. */
  restore: (folder: LocalFolder) => void;
  /** The confirm dialog while a question is open; render it anywhere. */
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const [pending, setPending] = useState<LocalFolder | null>(null);
  const { archivePersonalFolder } = tree;

  const cancel = useCallback(() => setPending(null), []);

  const restore = useCallback(
    (folder: LocalFolder) => {
      archivePersonalFolder(folder.id, false);
      toast.success(t("library.archive.restored", { name: folder.name }));
    },
    [archivePersonalFolder, t]
  );

  const dialog = pending ? (
    <ConfirmDialog
      tone="default"
      title={t("library.archive.title", { name: pending.name })}
      body={t("library.archive.body")}
      confirmLabel={t("sidebar.menu.archive")}
      cancelLabel={t("common.cancel")}
      onConfirm={() => {
        const folder = pending;
        setPending(null);
        archivePersonalFolder(folder.id, true);
        toast.success(t("library.archive.done", { name: folder.name }));
      }}
      onCancel={cancel}
    />
  ) : null;

  return { requestArchive: setPending, restore, dialog };
}
