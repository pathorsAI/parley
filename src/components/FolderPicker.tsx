import { useEffect, useState } from "react";
import {
  createLocalFolder,
  emitFoldersUpdated,
  listLocalFolders,
  listenForFoldersUpdated,
  type Folder,
} from "../lib/history/folders";
import { useI18n } from "../i18n";
import { Combobox } from "@/components/ui/combobox";

/**
 * THE control for "which folder does this recording live in".
 *
 * One folder is one customer, so this is also the only "whose call was this"
 * affordance — the import dialogs and the replay chip both mount the same
 * picker rather than each growing their own, which is how the app used to
 * end up with two disagreeing answers. Typing a name nothing matches creates
 * that folder, so a first-time customer costs one keystroke.
 */
export function FolderPicker({
  value,
  onChange,
  size = "sm",
}: Readonly<{
  value: string | null;
  onChange: (folderId: string | null) => void;
  size?: "sm" | "default";
}>) {
  const { t } = useI18n();
  // The registry is shared across windows, so re-read on the broadcast rather
  // than snapshotting it once at mount.
  const [folders, setFolders] = useState<Folder[]>(() => listLocalFolders());
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setFolders(listLocalFolders()));
    return () => {
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <Combobox
      size={size}
      value={value ?? ""}
      groups={[
        {
          options: [
            { value: "", label: t("library.unassigned") },
            ...folders.map((f) => ({ value: f.id, label: f.name })),
          ],
        },
      ]}
      onChange={(v) => onChange(v || null)}
      onCreate={(name) => {
        const created = createLocalFolder(name);
        setFolders(listLocalFolders());
        onChange(created.id);
        emitFoldersUpdated().catch(() => {});
      }}
      createLabel={(name) => t("owner.create", { name })}
      placeholder={t("library.unassigned")}
      searchPlaceholder={t("folder.search")}
      emptyText={t("folder.noMatch")}
    />
  );
}
