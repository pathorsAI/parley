import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Pencil, Sparkles } from "lucide-react";
import { AskYourAi } from "./AskYourAi";
import { toast } from "sonner";
import { transcriptAsText, useStore } from "../../lib/store";
import { STUDY_TABS, type StudyTab } from "../../lib/store/study";
import { renameLoadedRecording, renameTarget } from "../../lib/replay/rename";
import { studyPageTextFromState, useHandoff } from "../../lib/onboarding/useHandoff";
import { useTypewriter } from "../../lib/onboarding/motion";
import { log } from "../../lib/log";
import { useI18n, type TranslationKey } from "../../i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FilingRow } from "./FilingRow";

const TAB_LABEL: Record<StudyTab, TranslationKey> = {
  summary: "study.tab.summary",
  actions: "study.tab.actions",
  notes: "study.tab.notes",
  context: "study.tab.context",
  delivery: "study.tab.delivery",
  replay: "study.tab.replay",
};

/** The tabpanel the tablist controls (StudyScreen renders it). */
export const STUDY_TABPANEL_ID = "study-tabpanel";
export const studyTabId = (tab: StudyTab) => `study-tab-${tab}`;

/**
 * The recording page's header, above whichever tab is open: the recording's
 * name (click to rename) with the copy menu, where it is filed, and the tabs.
 * The titlebar keeps only the analysis chip — the tabs belong to the recording,
 * so they sit under its name.
 */
export function StudyHeader({
  tab,
  notesCount,
  hasContext,
  pickerOpen,
  onPickerOpenChange,
}: Readonly<{
  /** The tab on screen (already resolved: no notes → never "notes"). */
  tab: StudyTab;
  /** How many notes were taken in the meeting; 0 hides the notes tab. */
  notesCount: number;
  /** Whether the meeting had a prepared background; false hides its tab. */
  hasContext: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
}>) {
  const entryId = useStore((s) => s.loadedHistoryId);
  return (
    <header className="shrink-0 border-b border-border px-6 pt-4">
      <div className="flex items-center gap-2">
        {/* Keyed by recording: the title types itself in once per recording. */}
        <RecordingTitle key={entryId ?? "unsaved"} />
        <AskYourAi />
        <StudyCopyMenu tab={tab} />
      </div>
      <div className="mt-1.5">
        <FilingRow pickerOpen={pickerOpen} onPickerOpenChange={onPickerOpenChange} />
      </div>
      <StudyTabs tab={tab} notesCount={notesCount} hasContext={hasContext} />
    </header>
  );
}

/**
 * The recording's name as a large button that turns into an input on click
 * (Enter or clicking away saves, Esc cancels) — the titlebar crumb's rename
 * path (renameLoadedRecording). Next to it, while the name is still the one
 * the filing pass gave it this session, a quiet 「自動命名」 tag: Parley named
 * it, so the user knows it is theirs to change. Any rename retires the tag
 * (renameHistoryEntry clears the flag). Read-only org recordings and unsaved
 * sessions show the name as plain text.
 */
function RecordingTitle() {
  const { t } = useI18n();
  const name = useStore((s) => s.replay?.name ?? "");
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const editable = useStore((s) => !s.replayReadOnly) && !!loadedHistoryId;
  const autoNamed = useStore((s) => !!s.loadedHistoryId && s.titleAutoApplied === s.loadedHistoryId);
  const [draft, setDraft] = useState<string | null>(null);
  // Esc unmounts the input, and some engines fire blur on the way out — which
  // would commit the very edit Esc just threw away.
  const cancelled = useRef(false);

  // The name Parley just gave it types itself in, so it reads as something
  // that just happened rather than a name that was always there. Only when it
  // lands while the page is open; reopening shows it settled.
  const [typeIn, setTypeIn] = useState(false);
  const wasAuto = useRef(autoNamed);
  useLayoutEffect(() => {
    if (autoNamed && !wasAuto.current) setTypeIn(true);
    wasAuto.current = autoNamed;
  }, [autoNamed]);
  const shown = useTypewriter(name, typeIn);

  const commit = () => {
    if (cancelled.current || draft === null) return;
    cancelled.current = true;
    setDraft(null);
    const clean = renameTarget(draft, name, loadedHistoryId);
    if (!clean || !loadedHistoryId) return;
    renameLoadedRecording(loadedHistoryId, clean).catch((e) => {
      log.error("study: rename failed", { id: loadedHistoryId, error: String(e) });
      toast.error(t("replay.renameFailed", { error: e instanceof Error ? e.message : String(e) }));
    });
  };

  let title;
  if (draft !== null) {
    title = (
      <input
        // The user just clicked to edit.
        autoFocus
        value={draft}
        aria-label={t("study.title.edit")}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            setDraft(null);
          }
        }}
        className="-mx-1.5 h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-lg font-semibold outline-none focus-visible:border-ring"
      />
    );
  } else if (editable) {
    title = (
      <button
        type="button"
        title={t("study.title.edit")}
        onClick={() => {
          cancelled.current = false;
          setDraft(name);
        }}
        className="group/title -mx-1.5 flex min-w-0 cursor-text items-center gap-1.5 rounded-md px-1.5 text-left text-lg font-semibold transition-colors hover:bg-muted/60"
      >
        <span className="min-w-0 truncate">{shown}</span>
        {/* Says the title is editable before anyone has to discover it. */}
        <Pencil className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/title:text-muted-foreground" />
      </button>
    );
  } else {
    title = (
      <h1 className="min-w-0 truncate text-lg font-semibold" title={name}>
        {name}
      </h1>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {title}
      {autoNamed && draft === null && (
        <span
          title={t("study.title.autoNamedHint")}
          className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <Sparkles className="size-3" />
          {t("study.title.autoNamed")}
        </span>
      )}
    </div>
  );
}

/**
 * 複製: the open tab as text, the transcript, or the transcript wrapped in the
 * analysis prompt (the transcript copy menu's hand-off — same text, same toast,
 * same getting-started tick). Read-only org copies and empty transcripts can't
 * hand off, as everywhere else.
 */
function StudyCopyMenu({ tab }: Readonly<{ tab: StudyTab }>) {
  const { t } = useI18n();
  const handoff = useHandoff();

  const copy = async (text: string) => {
    if (!text.trim()) {
      toast(t("study.copy.empty"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("study.copy.done"));
    } catch (e) {
      log.warn("study: clipboard copy failed", { error: String(e) });
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5">
          <Copy className="size-3.5" />
          {t("study.copy")}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem onSelect={() => void copy(studyPageTextFromState(useStore.getState(), tab))}>
          {t("study.copy.page")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            const s = useStore.getState();
            void copy(transcriptAsText(s.segments, s.speakerNames));
          }}
        >
          {t("study.copy.transcript")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!handoff.canCopy} onSelect={() => void handoff.copyPrompt()}>
          {t("study.copy.prompt")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The underline tablist. Counts ride next to 後續行動 and 筆記 when non-zero;
 *  the notes tab exists only when notes were taken, the 會議背景 tab only when
 *  the meeting had a prepared background. */
function StudyTabs({
  tab,
  notesCount,
  hasContext,
}: Readonly<{ tab: StudyTab; notesCount: number; hasContext: boolean }>) {
  const { t } = useI18n();
  const actionCount = useStore((s) => s.actionItems.length);
  const setStudyTab = useStore((s) => s.setStudyTab);
  const tabs = STUDY_TABS.filter(
    (id) => (id !== "notes" || notesCount > 0) && (id !== "context" || hasContext)
  );
  const counts: Partial<Record<StudyTab, number>> = { actions: actionCount, notes: notesCount };

  return (
    <div role="tablist" aria-label={t("study.tabs")} className="mt-2 flex items-end gap-5">
      {tabs.map((id) => {
        const active = id === tab;
        const count = counts[id] ?? 0;
        return (
          <button
            key={id}
            id={studyTabId(id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={STUDY_TABPANEL_ID}
            tabIndex={active ? 0 : -1}
            onClick={() => setStudyTab(id)}
            onKeyDown={(e) => {
              // Arrow keys move along the tabs (WAI-ARIA tabs pattern).
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const at = tabs.indexOf(id) + (e.key === "ArrowRight" ? 1 : -1);
              const next = tabs[(at + tabs.length) % tabs.length];
              setStudyTab(next);
              document.getElementById(studyTabId(next))?.focus();
            }}
            className={cn(
              "relative flex cursor-pointer items-center gap-1.5 pb-2 pt-1 text-sm transition-colors",
              active ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(TAB_LABEL[id])}
            {count > 0 && (
              <span
                className={cn(
                  "min-w-4 rounded-full px-1 text-center text-[10px] font-medium leading-4 tabular-nums",
                  active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                {count}
              </span>
            )}
            {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}
