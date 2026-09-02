import { useCallback, useEffect, useMemo, useRef } from "react";
import { Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { createLocalFolder, emitFoldersUpdated } from "../../lib/history/folders";
import { personalDestination } from "../../lib/library/destination";
import { useRefile } from "../useRefile";
import type { FilingSuggestion, FilingFolderSuggestion } from "../../lib/types";

/**
 * The one-click home for the post-transcription filing suggestion: what this
 * recording should be CALLED and where it should LIVE.
 *
 * Both doors into a finished recording name it badly. A live meeting is saved as
 * "即時會議 · <date>" and an upload keeps whatever the file was called, so the
 * library fills up with rows nobody can tell apart. Filing is worse: the ingest
 * wizard asks which folder to use BEFORE transcription, at the one moment when
 * nobody — not the user, not the model — yet knows what the meeting was about.
 * So the good answer can only be produced afterwards, and it has to be offered
 * somewhere the user is already looking. That is the report page, directly above
 * the filing bar that shows the folder this would change.
 *
 * It is a SUGGESTION, not a control: soft accent, one button per row, and a
 * dismiss. Nothing here happens on its own.
 *
 * Acceptance state is DERIVED, never stored. Each row compares the suggestion
 * against live state and hides itself when it has nothing left to offer — the
 * title row when the recording is already called that, a folder chip when the
 * recording is already filed there. An "applied" flag would only be a second
 * copy of that same fact, free to drift: renaming from the titlebar, or filing
 * from the bar below, would leave a stale row claiming there is still something
 * to accept. Deriving it means every route to the same outcome retires the row.
 * Once BOTH rows are empty the suggestion has been fully spent, so it is cleared
 * from the store and persisted as null — it must not come back on the next load,
 * and must not be regenerated.
 */
export function FilingSuggestionCard() {
  const { t } = useI18n();
  const suggestion = useStore((s) => s.filingSuggestion);
  const setFilingSuggestion = useStore((s) => s.setFilingSuggestion);
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  // Same derivation as StudyLinkBar: a read-only org recording can't be written
  // back, and a session with no saved entry has nothing to rename or re-file.
  const readOnly = useStore((s) => s.replayReadOnly) || !loadedHistoryId;
  const replayName = useStore((s) => s.replay?.name ?? "");
  const renameReplay = useStore((s) => s.renameReplay);
  const folderId = useStore((s) => s.replayFolderId);
  const refile = useRefile();

  const suggestedTitle = suggestion?.title.trim() ?? "";
  // Nothing to offer once the recording already carries the suggested name —
  // however it got there (this card, or the titlebar's rename).
  const showTitle = suggestedTitle !== "" && suggestedTitle !== replayName.trim();

  // Drop the chip pointing at the folder the recording is ALREADY in. A
  // new-folder chip carries folderId === null, which is also the "personal root"
  // id, so it is compared out explicitly rather than by equality — an unfiled
  // recording is exactly the case a new folder is being proposed for.
  const chips = useMemo(
    () => (suggestion?.folders ?? []).filter((f) => f.folderId === null || f.folderId !== folderId),
    [suggestion, folderId]
  );

  const spent = !!suggestion && !showTitle && chips.length === 0;

  // Resolve a fully-spent suggestion for good. Keyed on the suggestion object so
  // it fires once per suggestion: `spent` stays true until the store clears, and
  // a later recording gets its own object and its own chance to resolve.
  const resolvedRef = useRef<FilingSuggestion | null>(null);
  useEffect(() => {
    if (!spent || !suggestion || resolvedRef.current === suggestion) return;
    resolvedRef.current = suggestion;
    setFilingSuggestion(null);
    void import("../../lib/history/history")
      .then((m) => m.persistFilingSuggestion())
      .catch((e) => log.warn("filing: clearing a spent suggestion failed", { error: String(e) }));
  }, [spent, suggestion, setFilingSuggestion]);

  const dismiss = useCallback(() => {
    setFilingSuggestion(null);
    void import("../../lib/history/history")
      .then((m) => m.persistFilingSuggestion())
      .catch((e) => log.warn("filing: persisting a dismissal failed", { error: String(e) }));
  }, [setFilingSuggestion]);

  // The titlebar's rename path, reused verbatim — one write, one failure toast.
  // Deliberately does NOT dismiss: the title row retires itself once the name
  // matches, and the folder chips are still worth a click.
  const applyTitle = useCallback(() => {
    const clean = suggestedTitle;
    if (!clean || clean === replayName.trim() || !loadedHistoryId) return;
    const rename = async () => {
      const { renameHistoryEntry } = await import("../../lib/history/history");
      await renameHistoryEntry(loadedHistoryId, clean);
      renameReplay(clean);
      toast.success(t("study.filing.titleApplied"));
    };
    // Kept synchronous so the handler can be passed to onClick directly: an
    // `async` callback would have to be discarded at the call site, and the
    // rejection is already handled here.
    rename().catch((e) => {
      log.error("filing: rename failed", { id: loadedHistoryId, error: String(e) });
      toast.error(
        t("replay.renameFailed", { error: e instanceof Error ? e.message : String(e) })
      );
    });
  }, [suggestedTitle, replayName, loadedHistoryId, renameReplay, t]);

  // Filing shows up in the bar immediately below, so the card has said all it
  // has to say — retire it rather than leave a redundant copy on screen.
  //
  // The store clears at once (the card must not linger for a disk round-trip),
  // but the PERSIST waits for the move to land: both writes are read-modify-write
  // over the same meta.json, so running them concurrently lets whichever finishes
  // last overwrite the other from a stale read — losing the folder the user just
  // picked, visibly only after a reload. Hence sequencing rather than `dismiss()`.
  const applyFolder = useCallback(
    (chip: FilingFolderSuggestion) => {
      let id = chip.folderId;
      if (id === null) {
        id = createLocalFolder(chip.name).id;
        emitFoldersUpdated().catch((e) =>
          log.warn("filing: folder broadcast failed", { error: String(e) })
        );
      }
      setFilingSuggestion(null);
      void refile(personalDestination(id), null)
        .then(() => import("../../lib/history/history"))
        .then((m) => m.persistFilingSuggestion())
        .catch((e) => log.warn("filing: persisting after a move failed", { error: String(e) }));
    },
    [refile, setFilingSuggestion]
  );

  if (!suggestion || readOnly) return null;
  if (!showTitle && chips.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-violet-700 dark:text-violet-300">
          {t("study.filing.heading")}
        </span>
        <button
          type="button"
          aria-label={t("study.filing.dismiss")}
          title={t("study.filing.dismiss")}
          onClick={dismiss}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {showTitle && (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("study.filing.titleLabel")}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={suggestedTitle}>
            {suggestedTitle}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={applyTitle}
          >
            {t("study.filing.apply")}
          </Button>
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-2 flex items-start gap-2">
          <span className="shrink-0 pt-1 text-xs text-muted-foreground">
            {t("study.filing.folderLabel")}
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chips.map((chip) => {
              const isNew = chip.folderId === null;
              return (
                <button
                  key={chip.folderId ?? `new:${chip.name}`}
                  type="button"
                  title={chip.reason || undefined}
                  onClick={() => applyFolder(chip)}
                  className={`flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted ${
                    isNew ? "border-dashed text-muted-foreground" : "bg-background"
                  }`}
                >
                  {isNew && <Plus className="size-3 shrink-0" />}
                  <span className="truncate">
                    {isNew ? t("study.filing.newFolder", { name: chip.name }) : chip.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
