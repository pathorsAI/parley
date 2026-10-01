import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FolderSearch, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { createLocalFolder, emitFoldersUpdated } from "../../lib/history/folders";
import { personalDestination } from "../../lib/library/destination";
import { useRefile } from "../useRefile";
import { flyToFolder, useTypewriter } from "../../lib/onboarding/motion";
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
 *
 * Three ways to act on it, and only the ones that FILE tick the
 * getting-started "filed" step (the lap's first step, lib/onboarding/lap.ts):
 *  - 採用建議 / Accept suggestion takes the whole thing in one click: the
 *    proposed title (as edited) and the first folder, created if new.
 *  - A folder chip files there without renaming; "Choose another…" opens the
 *    filing bar's destination picker (`onPickAnother`).
 *  - The title is editable in place (click, type, Enter or click away; Esc
 *    cancels). That renames and nothing else — the edit becomes the
 *    suggestion's title, so the title row retires by the usual rule.
 *
 * The first time a card appears for a recording it springs in and types its
 * title — the suggestion should look like something that just happened. A
 * filed card flies into its sidebar folder (lib/onboarding/motion.ts).
 */
/** Recordings whose card has already made its entrance this session. */
const introduced = new Set<string>();


export function FilingSuggestionCard({
  onPickAnother,
}: Readonly<{ onPickAnother?: () => void }>) {
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

  const cardRef = useRef<HTMLDivElement | null>(null);

  // First appearance for this recording → spring in and type the title. Read
  // purely during render; recorded in a layout effect (before paint), so the
  // entrance never flashes the finished card first.
  const visible = !!suggestion && !readOnly && (showTitle || chips.length > 0);
  const introduce = visible && !!loadedHistoryId && !introduced.has(loadedHistoryId);
  const [introducedFor, setIntroducedFor] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!introduce || !loadedHistoryId) return;
    introduced.add(loadedHistoryId);
    setIntroducedFor(loadedHistoryId);
  }, [introduce, loadedHistoryId]);
  const entering = introduce || (!!loadedHistoryId && introducedFor === loadedHistoryId);
  const typedTitle = useTypewriter(suggestedTitle, entering);

  /** The chip's folder id, creating the folder first when it is a new one. */
  const resolveFolder = useCallback((chip: FilingFolderSuggestion): string => {
    if (chip.folderId !== null) return chip.folderId;
    const id = createLocalFolder(chip.name).id;
    emitFoldersUpdated().catch((e) => log.warn("filing: folder broadcast failed", { error: String(e) }));
    return id;
  }, []);

  // The titlebar's rename path, reused verbatim — one write, one failure toast.
  // An in-place edit renames and nothing more: the chips stay on offer, and
  // renaming is not filing, so no checklist step moves.
  const applyTitle = useCallback(
    (title: string) => {
      const clean = title.trim();
      if (!clean || clean === replayName.trim() || !loadedHistoryId) return;
      // The edit becomes the suggestion, so "name === suggestion" keeps being
      // the one test that retires the row.
      const edited = !!suggestion && clean !== suggestedTitle;
      if (edited) setFilingSuggestion({ ...suggestion, title: clean });
      const rename = async () => {
        const history = await import("../../lib/history/history");
        await history.renameHistoryEntry(loadedHistoryId, clean);
        renameReplay(clean);
        toast.success(t("study.filing.titleApplied"));
        // Keep the edit across a reopen while chips are still on offer. With
        // none left the card is spent, and the effect above persists the null.
        if (edited && chips.length > 0) await history.persistFilingSuggestion();
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
    },
    [suggestion, suggestedTitle, replayName, loadedHistoryId, renameReplay, setFilingSuggestion, chips.length, t]
  );

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
      const id = resolveFolder(chip);
      void flyToFolder(cardRef.current, id);
      setFilingSuggestion(null);
      void refile(personalDestination(id), null)
        .then(() => import("../../lib/history/history"))
        .then((m) => m.persistFilingSuggestion())
        .catch((e) => log.warn("filing: persisting after a move failed", { error: String(e) }));
    },
    [refile, resolveFolder, setFilingSuggestion]
  );

  // 採用建議: the whole suggestion in one click — the title (as edited), then
  // the first folder. Three writes to one meta.json, so strictly in sequence:
  // rename, move (which ticks "filed", after the name has changed so the lap's
  // confirmation can say both), then persist the cleared suggestion.
  const acceptAll = useCallback(() => {
    if (!loadedHistoryId) return;
    const title = showTitle ? suggestedTitle : "";
    const chip = chips[0] ?? null;
    const target = chip ? resolveFolder(chip) : null;
    if (target) void flyToFolder(cardRef.current, target);
    setFilingSuggestion(null);
    const run = async () => {
      const history = await import("../../lib/history/history");
      if (title) {
        await history.renameHistoryEntry(loadedHistoryId, title);
        renameReplay(title);
      }
      if (target) await refile(personalDestination(target), null);
      await history.persistFilingSuggestion();
    };
    run().catch((e) => {
      log.error("filing: accepting the suggestion failed", { id: loadedHistoryId, error: String(e) });
      toast.error(t("replay.renameFailed", { error: e instanceof Error ? e.message : String(e) }));
    });
  }, [loadedHistoryId, showTitle, suggestedTitle, chips, resolveFolder, setFilingSuggestion, renameReplay, refile, t]);

  if (!visible) return null;

  return (
    // Plain text on the page above a hairline — no tinted box; blue marks
    // only what can be clicked.
    <div
      ref={cardRef}
      id="filing-suggestion"
      className={`mb-3 scroll-mt-4 border-b border-border pb-3 ${entering ? "ob-spring-in" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {t("study.filing.heading")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 text-xs text-primary hover:bg-primary/10 hover:text-primary"
          onClick={acceptAll}
        >
          {t("study.filing.apply")}
        </Button>
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
          <EditableTitle value={suggestedTitle} shown={typedTitle} onCommit={applyTitle} />
        </div>
      )}

      {(chips.length > 0 || onPickAnother) && (
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
                  className={`flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-primary/30 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 ${
                    isNew ? "border-dashed" : ""
                  }`}
                >
                  {isNew && <Plus className="size-3 shrink-0" />}
                  <span className="truncate">
                    {isNew ? t("study.filing.newFolder", { name: chip.name }) : chip.name}
                  </span>
                </button>
              );
            })}
            {onPickAnother && (
              <button
                type="button"
                onClick={onPickAnother}
                className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FolderSearch className="size-3 shrink-0" />
                {t("study.filing.pickAnother")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The proposed title as text that turns into an input on click. Enter or
 * clicking away applies an edit; Esc restores the proposal.
 */
function EditableTitle({
  value,
  shown = value,
  onCommit,
}: Readonly<{
  value: string;
  /** What to display while not editing (the typewriter's progress). */
  shown?: string;
  onCommit: (title: string) => void;
}>) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  // Esc unmounts the input, and some engines fire blur on the way out — which
  // would commit the very edit Esc just threw away.
  const cancelled = useRef(false);

  if (draft === null) {
    return (
      <button
        type="button"
        title={t("study.filing.editTitle")}
        aria-label={t("study.filing.editTitle")}
        onClick={() => {
          cancelled.current = false;
          setDraft(value);
        }}
        className="min-w-0 flex-1 cursor-text truncate rounded px-1 -mx-1 text-left text-sm font-medium transition-colors hover:bg-muted/60"
      >
        {shown}
      </button>
    );
  }

  // An edit applies on Enter or on clicking away. Enter on the untouched
  // proposal is 採用 by keyboard; clicking away from it just closes the field.
  const commit = (viaEnter: boolean) => {
    if (cancelled.current) return;
    cancelled.current = true;
    const next = draft.trim();
    setDraft(null);
    if (next && (next !== value || viaEnter)) onCommit(next);
  };

  return (
    <input
      // The user just clicked to edit.
      autoFocus
      value={draft}
      aria-label={t("study.filing.titleLabel")}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => commit(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          setDraft(null);
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-sm font-medium outline-none focus-visible:border-ring"
    />
  );
}
