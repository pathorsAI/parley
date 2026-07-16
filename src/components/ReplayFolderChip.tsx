import { useEffect, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, Folder, FolderClosed } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../lib/store";
import {
  listLocalFolders,
  listenForFoldersUpdated,
  type Folder as LocalFolder,
} from "../lib/history/folders";
import { setEntryFolder, emitHistoryUpdated } from "../lib/history/history";
import { useI18n } from "../i18n";
import { log } from "../lib/log";

/**
 * The loaded recording's filing location, right in the replay titlebar — the
 * "臨時開會、事後歸位" affordance: a meeting recorded without picking a save
 * destination lands unfiled, and this chip both SHOWS that (amber "unfiled")
 * and fixes it in one click, no History-window trip. Personal recordings only:
 * an unsaved upload or a read-only org recording has no loadedHistoryId and
 * renders nothing. Uses the same radix Popover-portal pattern as
 * SaveDestinationPicker (the titlebar's backdrop-blur traps fixed overlays).
 */
export function ReplayFolderChip() {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const folderId = useStore((s) => s.replayFolderId);
  const setReplayFolderId = useStore((s) => s.setReplayFolderId);
  const [folders, setFolders] = useState<LocalFolder[]>(() => listLocalFolders());
  const [open, setOpen] = useState(false);

  // Reflect folder create/rename/delete done in the History window live.
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setFolders(listLocalFolders()));
    return () => {
      un.then((fn) => fn()).catch((error) =>
        log.warn("replay-folder: listener cleanup failed", { error: String(error) })
      );
    };
  }, []);

  if (!loadedHistoryId) return null;

  const current = folders.find((f) => f.id === folderId) ?? null;
  // An orphaned folderId (folder since deleted) reads as unfiled — matching the
  // History grid's orphan→root rule.
  const unfiled = !current;

  async function move(nextId: string | null) {
    setOpen(false);
    if (!loadedHistoryId || nextId === (current?.id ?? null)) return;
    const name =
      nextId === null
        ? t("history.move.rootOption")
        : folders.find((f) => f.id === nextId)?.name ?? "";
    try {
      await setEntryFolder(loadedHistoryId, nextId);
      setReplayFolderId(nextId);
      await emitHistoryUpdated(loadedHistoryId);
      toast.message(t("replay.folder.moved", { name }));
    } catch (e) {
      log.error("replay-folder: move failed", { id: loadedHistoryId, error: String(e) });
      toast.error(t("history.move.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const options: { id: string | null; name: string }[] = [
    { id: null, name: t("history.move.rootOption") },
    ...folders.map((f) => ({ id: f.id, name: f.name })),
  ];

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title={t("replay.folder.title")}
          className={`flex max-w-36 shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-muted ${
            unfiled
              ? "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {unfiled ? (
            <FolderClosed className="size-3 shrink-0" />
          ) : (
            <Folder className="size-3 shrink-0" />
          )}
          <span className="truncate">{unfiled ? t("replay.folder.unfiled") : current.name}</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("history.move.menuTitle")}
          </p>
          <div className="max-h-64 overflow-y-auto">
            {options.map((o) => {
              const isCurrent = (current?.id ?? null) === o.id;
              return (
                <button
                  key={o.id ?? "__root"}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => void move(o.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  {o.id === null ? (
                    <FolderClosed className="size-3 shrink-0" />
                  ) : (
                    <Folder className="size-3 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{o.name}</span>
                  {isCurrent && (
                    <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
