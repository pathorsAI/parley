import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Folder, FolderSearch, MoreHorizontal, Plus } from "lucide-react";
import { useStore } from "../../lib/store";
import { createLocalFolder, emitFoldersUpdated, listLocalFolders } from "../../lib/history/folders";
import { personalDestination } from "../../lib/library/destination";
import { flyToFolder } from "../../lib/onboarding/motion";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import type { FilingFolderSuggestion, FilingSuggestion } from "../../lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DestinationSheet } from "../DestinationSheet";
import { useRefile } from "../useRefile";
import { MeetingContextSheet } from "../MeetingContextButton";
import { MeetingKindPicker } from "../MeetingKindPicker";

/** Recordings whose folder suggestion has already made its entrance this session. */
const introduced = new Set<string>();

/**
 * The recording page header's second row: WHERE this recording lives, and what
 * KIND of meeting it was — the control that decides which analysis the tabs
 * below are written with. Both belong here rather than in the titlebar: the
 * report is where you find out the kind was wrong, so it is where you fix it.
 *
 * Three filing states, one line each:
 *  - filed → the folder's name and 「變更」, which opens the destination picker;
 *  - unfiled with a folder suggestion → 「建議放進」 and one chip per suggested
 *    folder (the first one emphasized; a new-folder chip is dashed and creates
 *    the folder), 「選其他資料夾…」 and 「先不歸檔」 (dismiss);
 *  - unfiled, nothing suggested → 「還沒歸檔」 and 「放進資料夾」.
 *
 * The suggestion's TITLE is not offered here: the filing pass names the
 * recording on its own (lib/analysis/filingRun.ts), so only the folder half is
 * a suggestion. Whether the suggestion is still worth showing is DERIVED from
 * live state, never stored: a chip pointing at the folder the recording is
 * already in is dropped, and once the recording is filed — however it got
 * there — or no chip is left, the suggestion is spent, cleared from the store
 * and persisted as null so it never comes back on the next load.
 *
 * Filing from a chip ticks the getting-started "filed" step (via useRefile, the
 * same path as the picker) and flies the chip into its sidebar folder. The
 * first time a suggestion shows for a recording it springs in.
 *
 * Read-only org recordings and unsaved sessions can't be written back, so they
 * get no filing actions (the kind still shows — it explains what you read).
 *
 * The destination picker's open state is owned by the caller so the guide bar
 * opens this same sheet.
 */
export function FilingRow({
  pickerOpen,
  onPickerOpenChange,
}: Readonly<{ pickerOpen: boolean; onPickerOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  // Nothing to re-file: a read-only org recording can't be written back, and a
  // session with no saved entry (never saved, or just handed over to an org)
  // has nothing for the picker to act on.
  const readOnly = useStore((s) => s.replayReadOnly) || !loadedHistoryId;
  const folderId = useStore((s) => s.replayFolderId);
  const suggestion = useStore((s) => s.filingSuggestion);
  const setFilingSuggestion = useStore((s) => s.setFilingSuggestion);
  const refile = useRefile();
  const folder = folderId ? (listLocalFolders().find((f) => f.id === folderId) ?? null) : null;
  const [contextOpen, setContextOpen] = useState(false);

  // Drop the chip pointing at the folder the recording is ALREADY in. A
  // new-folder chip carries folderId === null, which is also the "personal root"
  // id, so it is compared out explicitly rather than by equality — an unfiled
  // recording is exactly the case a new folder is being proposed for.
  const chips = useMemo(
    () => (suggestion?.folders ?? []).filter((f) => f.folderId === null || f.folderId !== folderId),
    [suggestion, folderId]
  );
  const spent = !!suggestion && (!!folderId || chips.length === 0);
  const offering = !readOnly && !folderId && chips.length > 0;

  // Resolve a spent suggestion for good. Keyed on the suggestion object so it
  // fires once per suggestion: `spent` stays true until the store clears, and a
  // later recording gets its own object and its own chance to resolve.
  const resolvedRef = useRef<FilingSuggestion | null>(null);
  useEffect(() => {
    if (readOnly || !spent || !suggestion || resolvedRef.current === suggestion) return;
    resolvedRef.current = suggestion;
    setFilingSuggestion(null);
    void import("../../lib/history/history")
      .then((m) => m.persistFilingSuggestion())
      .catch((e) => log.warn("filing: clearing a spent suggestion failed", { error: String(e) }));
  }, [readOnly, spent, suggestion, setFilingSuggestion]);

  // 先不歸檔: the suggestion is answered, so it must not come back.
  const dismiss = useCallback(() => {
    setFilingSuggestion(null);
    void import("../../lib/history/history")
      .then((m) => m.persistFilingSuggestion())
      .catch((e) => log.warn("filing: persisting a dismissal failed", { error: String(e) }));
  }, [setFilingSuggestion]);

  /** The chip's folder id, creating the folder first when it is a new one. */
  const resolveFolder = useCallback((chip: FilingFolderSuggestion): string => {
    if (chip.folderId !== null) return chip.folderId;
    const id = createLocalFolder(chip.name).id;
    emitFoldersUpdated().catch((e) => log.warn("filing: folder broadcast failed", { error: String(e) }));
    return id;
  }, []);

  // The store clears at once (the chips must not linger for a disk round-trip),
  // but the PERSIST waits for the move to land: both writes are read-modify-write
  // over the same meta.json, so running them concurrently lets whichever finishes
  // last overwrite the other from a stale read — losing the folder the user just
  // picked, visibly only after a reload. Hence sequencing rather than `dismiss()`.
  const applyFolder = useCallback(
    (chip: FilingFolderSuggestion, source: HTMLElement | null) => {
      const id = resolveFolder(chip);
      void flyToFolder(source, id);
      setFilingSuggestion(null);
      void refile(personalDestination(id), null)
        .then(() => import("../../lib/history/history"))
        .then((m) => m.persistFilingSuggestion())
        .catch((e) => log.warn("filing: persisting after a move failed", { error: String(e) }));
    },
    [refile, resolveFolder, setFilingSuggestion]
  );

  // First appearance for this recording → spring in. Read purely during render;
  // recorded in a layout effect (before paint), so the entrance never flashes
  // the settled row first.
  const introduce = offering && !!loadedHistoryId && !introduced.has(loadedHistoryId);
  const [introducedFor, setIntroducedFor] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!introduce || !loadedHistoryId) return;
    introduced.add(loadedHistoryId);
    setIntroducedFor(loadedHistoryId);
  }, [introduce, loadedHistoryId]);
  const entering = introduce || (!!loadedHistoryId && introducedFor === loadedHistoryId);

  const openPicker = () => onPickerOpenChange(true);

  let filing;
  if (folder) {
    filing = (
      <>
        <span className="max-w-full truncate rounded-full border bg-background px-2 py-0.5 font-medium">
          {folder.name}
        </span>
        {!readOnly && <TextButton onClick={openPicker}>{t("study.link.change")}</TextButton>}
      </>
    );
  } else if (offering) {
    filing = (
      <div
        id="filing-suggestion"
        className={cn("flex min-w-0 flex-wrap items-center gap-1.5", entering && "ob-spring-in")}
      >
        <span className="text-muted-foreground">{t("study.filing.suggestLead")}</span>
        {chips.map((chip, i) => (
          <SuggestionChip
            key={chip.folderId ?? `new:${chip.name}`}
            chip={chip}
            primary={i === 0}
            label={chip.folderId === null ? t("study.filing.newFolder", { name: chip.name }) : chip.name}
            onPick={applyFolder}
          />
        ))}
        <button
          type="button"
          onClick={openPicker}
          className="flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FolderSearch className="size-3 shrink-0" />
          {t("study.filing.pickAnother")}
        </button>
        <TextButton muted onClick={dismiss}>
          {t("study.filing.notNow")}
        </TextButton>
      </div>
    );
  } else {
    filing = (
      <>
        <span className="text-muted-foreground">{t("study.link.unlinked")}</span>
        {!readOnly && <TextButton onClick={openPicker}>{t("study.link.attach")}</TextButton>}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{filing}</div>

      {/* What this recording is being read AS. Changing it doesn't re-run
          anything on its own — the analysis chip owns regeneration. */}
      <MeetingKindPicker className="h-7 w-[132px] shrink-0" />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("study.link.menu")}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setContextOpen(true)}>
            {t("study.link.context")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit flow → Sheet (repo rule). Nothing moves until the sheet's own
          button is pressed. */}
      <DestinationSheet
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        title={t("study.link.attach")}
        verb="move"
        current={personalDestination(folderId)}
        onConfirm={(destination, mode) => {
          void refile(destination, mode);
        }}
      />

      <MeetingContextSheet open={contextOpen} onOpenChange={setContextOpen} />
    </div>
  );
}

/** One suggested folder. The best guess is filled in; the rest are outlines; a
 *  folder that doesn't exist yet is dashed and says it will be created. */
function SuggestionChip({
  chip,
  primary,
  label,
  onPick,
}: Readonly<{
  chip: FilingFolderSuggestion;
  primary: boolean;
  label: string;
  onPick: (chip: FilingFolderSuggestion, source: HTMLElement | null) => void;
}>) {
  const isNew = chip.folderId === null;
  return (
    <button
      type="button"
      title={chip.reason || undefined}
      onClick={(e) => onPick(chip, e.currentTarget)}
      className={cn(
        "flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition-colors",
        primary
          ? "border-transparent bg-primary/10 text-primary hover:bg-primary/15"
          : "border-border text-foreground hover:bg-muted",
        isNew && "border-dashed",
        isNew && primary && "border-primary/40"
      )}
    >
      {isNew && <Plus className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function TextButton({
  onClick,
  muted,
  children,
}: Readonly<{ onClick: () => void; muted?: boolean; children: ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer underline-offset-2 transition-colors hover:underline",
        muted ? "text-muted-foreground hover:text-foreground" : "text-primary"
      )}
    >
      {children}
    </button>
  );
}
