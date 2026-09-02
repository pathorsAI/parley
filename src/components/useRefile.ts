import { useCallback } from "react";
import { toast } from "sonner";
import { setEntryFolder } from "../lib/history/history";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import type { LibraryDestination, OrgHandoffMode } from "../lib/library/destination";

/**
 * "事後歸位" for the recording currently open in replay — the action behind both
 * the titlebar chip and the report page's filing bar, which ask the same
 * question and so must not answer it two different ways.
 *
 * A personal destination just retags the local entry. An org destination is a
 * handoff: the copy leaves the personal library alone, the move deletes it once
 * the org copy is in. After a move there is no local entry left, so the replay
 * session drops its history pointer — the transcript on screen stays readable,
 * but a later re-analysis has nothing local to overwrite.
 *
 * It RESOLVES when the move has landed on disk, so a caller that also writes to
 * the same entry can sequence behind it. Both `setEntryFolder` and the study
 * persists are read-modify-write over one meta.json; started concurrently, the
 * later write reads a pre-move copy and silently drops the folder change (the
 * store already shows the new folder, so it only surfaces on the next load).
 * Callers with no follow-up write can ignore the promise — failures are logged
 * and toasted here either way.
 */
export function useRefile(): (
  destination: LibraryDestination,
  mode: OrgHandoffMode | null
) => Promise<void> {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const setLoadedHistoryId = useStore((s) => s.setLoadedHistoryId);

  return useCallback(
    (destination: LibraryDestination, mode: OrgHandoffMode | null) => {
      const id = loadedHistoryId;
      if (!id) return Promise.resolve();
      if (destination.scope === "personal") {
        return setEntryFolder(id, destination.folderId).catch((e) =>
          log.warn("refile: folder change failed", { id, error: String(e) })
        );
      }
      const { orgId, folderId } = destination;
      return import("../lib/cloud/sync")
        .then(async ({ moveRecordingToOrg, shareRecordingToOrg }) => {
          if (mode === "move") {
            await moveRecordingToOrg(id, orgId, folderId);
            setLoadedHistoryId(null);
            toast.success(t("history.move.movedToFolder"));
          } else {
            await shareRecordingToOrg(id, orgId, folderId);
            toast.success(t("history.move.copiedToFolder"));
          }
        })
        .catch((e) => {
          log.error("refile: org handoff failed", { id, orgId, error: String(e) });
          toast.error(t("history.move.failed", { error: e instanceof Error ? e.message : String(e) }));
        });
    },
    [loadedHistoryId, setLoadedHistoryId, t]
  );
}
