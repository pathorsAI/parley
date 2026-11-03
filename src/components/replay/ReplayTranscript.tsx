import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Replace, ReplaceAll, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "../../i18n";
import { formatChordLabel, modChordCap } from "../../lib/commands/format";
import { command } from "../../lib/commands/registry";
import { speakerLabel, speakerKey, defaultSpeakerLabel, formatClock, isTrimmed, useStore, type ReplayTrim } from "../../lib/store";
import { cn } from "@/lib/utils";
import { useCommandShortcut } from "../../lib/commands/bind";
import { markGettingStarted } from "../../lib/onboarding/gettingStarted";
import { useLapContext } from "../../lib/onboarding/lap";
import { emitTranscriptSeek } from "../../lib/onboarding/motion";
import { isTextSelected } from "../../lib/replay/selection";
import { countOccurrences } from "../../lib/replay/findReplace";
import { editChangeVars, replaceInTranscript, teachReplacement } from "../../lib/replay/transcriptEdit";
import { useStudyPipeline } from "../../lib/analysis/studyPipeline";
import { log } from "../../lib/log";
import type { TranscriptSegment } from "../../lib/types";
import { RegenAllSheet } from "../study/StudyGenerationChip";

interface ReplayTranscriptProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  /** Keep-window; lines outside it are greyed + struck (excluded from analysis). */
  trim: ReplayTrim | null;
  playheadMs: number;
  /** True while audio is playing — gates auto-scroll so we don't fight the user. */
  playing: boolean;
  /** Seek to a segment's start when its row is clicked. */
  onSeek: (ms: number) => void;
  emptyLabel: string;
  /** Preview (the ingest wizard): no playhead dimming — every line renders fully
   *  "lit". The active line still highlights while audio is playing (playheadMs>0)
   *  so the trim step's transcript follows playback. */
  preview?: boolean;
}

/**
 * Replay transcript: each segment is a clickable row. The segment covering the
 * playhead is highlighted; segments that start after the playhead are greyed out
 * (the "masked future" the evals/Ask can't see). While playing, the active row
 * is kept in view; when paused we leave scroll alone so manual scrolling sticks.
 *
 * The speaker badge that begins each speaker run doubles as a rename affordance:
 * clicking it opens an inline input (it does NOT seek — the click is stopped from
 * bubbling to the row). Saving calls `setSpeakerName(speakerKey(seg), name)`, the
 * same store action the live SpeakerBar uses, so the rename applies to every line
 * of that speaker and to the analysis context at once.
 *
 * The find bar also REPLACES (its chevron, ⌥⌘F, or "Replace…" on a text
 * selection): the edit lands in the store and the saved entry at once
 * (replay/transcriptEdit), a toast offers to teach the dictionary the fixed
 * word, and — when the recording already has outputs built from the old text —
 * a notice at the top offers to regenerate them. Never in the ingest-wizard
 * preview or on a read-only org recording, whose text is not the user's to edit.
 */
/** How long the guide bar's first-line pulse runs. */
const FIRST_LINE_PULSE_MS = 2000;

export function ReplayTranscript({
  segments,
  speakerNames,
  trim,
  playheadMs,
  playing,
  onSeek,
  emptyLabel,
  preview = false,
}: Readonly<ReplayTranscriptProps>) {
  const { t } = useI18n();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const setSpeakerName = useStore((s) => s.setSpeakerName);
  // Bumped on every explicit seek (scrubber, timeline finding, action item) so we
  // scroll to the jumped-to line even while paused.
  const seekNonce = useStore((s) => s.replaySeekNonce);
  // Which speaker key is being edited inline (null = none).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // A transcript that synced with no timing shows an estimated clock (#576) —
  // say so, so a jump that lands a few lines off doesn't read as a bug.
  const timingEstimated = useStore((s) => !preview && !!s.replay?.timingEstimated);
  // Replace is an edit to the user's own recording: not in the wizard preview,
  // not on someone else's read-only org recording.
  const canReplace = useStore((s) => !preview && !s.replayReadOnly);
  // The transcript was edited after the summary / action items / findings were
  // made from it (store.transcriptEditedId) — say so, and offer the rebuild.
  const outputsStale = useStore(
    (s) =>
      canReplace &&
      !!s.replay &&
      s.transcriptEditedId === s.replay.id &&
      (!!s.brief || s.actionItems.length > 0 || s.findings.length > 0)
  );
  const pipeline = useStudyPipeline();
  // Same lock as the titlebar chip's "regenerate all".
  const regenLocked = !pipeline.hasDeepKey || pipeline.diarizing;
  const [regenConfirming, setRegenConfirming] = useState(false);

  const lap = useLapContext();
  // While the guide bar is on its replay step, the first line pulses once, for
  // about two seconds — "this, click this" — then settles.
  const pulseDue = !preview && lap.visible && lap.phase === "replayed" && !lap.justCompleted;
  const [pulsing, setPulsing] = useState(false);
  const pulsed = useRef(false);
  useEffect(() => {
    if (!pulseDue || pulsed.current) return;
    setPulsing(true);
    // Spent only once it has run its course (a StrictMode re-mount restarts it).
    const id = setTimeout(() => {
      pulsed.current = true;
      setPulsing(false);
    }, FIRST_LINE_PULSE_MS);
    return () => {
      clearTimeout(id);
      setPulsing(false);
    };
  }, [pulseDue]);

  // A line click is the user's seek — it ticks the checklist (not in the wizard
  // preview) and retires the hint that taught it.
  function seekToLine(ms: number) {
    // Before the seek lands, so the scrubber has its easing on when it moves.
    if (!preview) emitTranscriptSeek(ms);
    onSeek(ms);
    if (preview) return;
    markGettingStarted("replayed");
  }

  // Ctrl/⌘F-style find: a floating bar over the transcript. A "match" is a LINE
  // (segment) whose text contains the query — Enter/arrows jump line-to-line and
  // the counter reads "current / total lines".
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  // The replace row under the find field (collapsed = the plain find bar).
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  // "Replace…" floating over a text selection in the transcript.
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);

  const rows = useMemo(
    () =>
      segments
        .filter((s) => s.text.trim())
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    [segments]
  );

  const trimmedQuery = query.trim();
  const searching = searchOpen && trimmedQuery.length > 0;
  const matchIds = useMemo(() => {
    if (!trimmedQuery) return [];
    const q = trimmedQuery.toLowerCase();
    return rows.filter((r) => r.text.toLowerCase().includes(q)).map((r) => r.id);
  }, [rows, trimmedQuery]);
  const currentMatchId = matchIds.length > 0 ? matchIds[Math.min(matchIdx, matchIds.length - 1)] : null;
  // "Replace all" counts OCCURRENCES, not lines — a line can hold the misheard
  // name twice, and the number on the button is the blast radius.
  const occurrenceCount = useMemo(
    () => (trimmedQuery ? rows.reduce((n, r) => n + countOccurrences(r.text, trimmedQuery), 0) : 0),
    [rows, trimmedQuery]
  );
  const replaceDisabled = matchIds.length === 0 || replacement === trimmedQuery;

  function openSearch() {
    setSearchOpen(true);
    // Focus after the bar renders (also re-focuses if it's already open).
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }

  function closeSearch() {
    setSearchOpen(false);
    setReplaceOpen(false);
    setQuery("");
    setMatchIdx(0);
  }

  /** Open the bar with the replace row out. With a query already there, the
   *  cursor goes to "Replace with" — that is the field left to fill. */
  function openReplace(prefill?: string) {
    if (prefill) setQuery(prefill);
    setSearchOpen(true);
    setReplaceOpen(true);
    const hasQuery = !!(prefill ?? query).trim();
    requestAnimationFrame(() => {
      const field = hasQuery ? replaceInputRef.current : searchInputRef.current;
      field?.focus();
      field?.select();
    });
  }

  function toggleReplace() {
    if (replaceOpen) {
      setReplaceOpen(false);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      openReplace();
    }
  }

  /** After a replace: say how many, and offer to teach the dictionary the
   *  fixed word so the next transcription gets it right. Never added on its
   *  own — only when the action is clicked. */
  function announceReplaced(count: number, from: string, to: string) {
    const term = to.trim();
    const teach = () => {
      teachReplacement(from, term)
        .then((added) =>
          added ? toast.success(t("replay.replacedTaught", { term })) : toast(t("replay.replacedKnown", { term }))
        )
        .catch((e) => {
          log.error("replay: dictionary add failed", { error: String(e) });
          toast.error(t("replay.replacedTeachFailed"));
        });
    };
    const { language } = useStore.getState().settings;
    toast(t("replay.replaced", { count, ...editChangeVars(language, { from, to }) }), {
      // Deleting a word (empty replacement) leaves nothing to teach.
      action: term ? { label: t("replay.replacedTeach"), onClick: teach } : undefined,
    });
  }

  /** Replace in the CURRENT match line only, then move on to the next match. */
  function replaceCurrent() {
    if (replaceDisabled || !currentMatchId) return;
    const at = Math.min(matchIdx, matchIds.length - 1);
    const count = replaceInTranscript(trimmedQuery, replacement, { onlySegmentId: currentMatchId });
    if (count === 0) {
      // Every hit on this line already reads as the replacement: just step on.
      stepMatch(1);
      return;
    }
    // The line usually stops matching, so the next match slides into this
    // index. A replacement that contains the query (派斯 → 派斯科技) keeps the
    // line in the list, and then the next match is one further on.
    const text = useStore.getState().segments.find((s) => s.id === currentMatchId)?.text ?? "";
    const stillMatches = countOccurrences(text, trimmedQuery) > 0;
    const remaining = stillMatches ? matchIds.length : matchIds.length - 1;
    const next = stillMatches ? at + 1 : at;
    setMatchIdx(remaining > 0 ? next % remaining : 0);
    announceReplaced(count, trimmedQuery, replacement);
  }

  function replaceAll() {
    if (replaceDisabled) return;
    const count = replaceInTranscript(trimmedQuery, replacement);
    if (count === 0) return;
    setMatchIdx(0);
    announceReplaced(count, trimmedQuery, replacement);
  }

  function stepMatch(dir: 1 | -1) {
    if (matchIds.length === 0) return;
    setMatchIdx((i) => (Math.min(i, matchIds.length - 1) + dir + matchIds.length) % matchIds.length);
  }

  // Opens (or REFOCUSES) the find bar — it has to keep working once the field it
  // opens already has focus, which is why the command carries `whileTyping` in
  // the registry. Not bound in the ingest-wizard preview, where the transcript
  // is a secondary pane and the find bar is not the thing you mean.
  useCommandShortcut(
    "replay.find",
    () => {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    { enabled: !preview }
  );
  // ⌥⌘F: the same bar with the replace row out — prefilled with the transcript
  // text the user has highlighted, if any.
  useCommandShortcut("replay.replace", () => openReplace(selectionAction?.text), { enabled: canReplace });
  const replaceChordLabel = formatChordLabel(command("replay.replace").keys[0]);

  // "Replace…" over a selection inside the transcript, like a selection
  // toolbar: shown while there is a single-line selection within the list,
  // gone when it collapses, the list scrolls, or Escape is pressed.
  useEffect(() => {
    if (!canReplace) {
      setSelectionAction(null);
      return;
    }
    const onSelectionChange = () =>
      setSelectionAction(selectionActionFor(globalThis.getSelection(), listRef.current, rootRef.current));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectionAction(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canReplace]);

  function replaceSelection() {
    const text = selectionAction?.text;
    if (!text) return;
    globalThis.getSelection()?.removeAllRanges();
    setSelectionAction(null);
    openReplace(text);
  }

  // Typing a new query restarts at the first match.
  useEffect(() => {
    setMatchIdx(0);
  }, [trimmedQuery]);

  // Bring the current match into view when the query or the position changes.
  useEffect(() => {
    if (!currentMatchId) return;
    rowRefs.current[currentMatchId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentMatchId, matchIdx]);

  // Index of the segment that "owns" the playhead: the last one started.
  const activeId = useMemo(() => {
    let id: string | null = null;
    for (const r of rows) {
      if (r.startMs <= playheadMs) id = r.id;
      else break;
    }
    return id;
  }, [rows, playheadMs]);

  // Keep the active row visible while playing — unless a search is in progress,
  // so playback doesn't yank the view away from the match being inspected.
  useEffect(() => {
    if (!playing || !activeId || searching) return;
    rowRefs.current[activeId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeId, playing, searching]);

  // On an explicit seek (scrubber / timeline / action item), scroll to the
  // jumped-to line even while paused — so audio ⇄ timeline ⇄ transcript stay in
  // sync in every direction. Manual transcript scrolling doesn't bump the nonce,
  // so it's never hijacked.
  useEffect(() => {
    if (!activeId) return;
    rowRefs.current[activeId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce]);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    // Scroll is captured here (it doesn't bubble): moving the list leaves the
    // floating "Replace…" pointing at nothing, so it goes.
    <div ref={rootRef} className="relative h-full" onScrollCapture={() => selectionAction && setSelectionAction(null)}>
      {selectionAction && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          // Act on the press, not the click: WebKit collapses the selection
          // as the mouse comes up, which unmounted this button before its
          // click could land — so clicking it did nothing. preventDefault
          // keeps the selection (the prefill) alive until then. The click
          // is still there for the keyboard.
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            replaceSelection();
          }}
          onClick={replaceSelection}
          style={{ left: selectionAction.left, top: selectionAction.top }}
          className="absolute z-20 -translate-x-1/2 -translate-y-full gap-1 bg-background shadow-md"
        >
          <Replace className="size-3" />
          {t("replay.replaceSelection")}
        </Button>
      )}
      {!preview &&
        (searchOpen ? (
          // VS Code's find widget: a full-height toggle strip on the left (›
          // closed, ⌄ open) that owns the replace row, each query in its own
          // field, arrows — not chevrons — to step through hits, and the two
          // replace actions as icon buttons named by their tooltips.
          <div
            data-transcript-undo
            className="absolute right-3 top-2 z-10 flex items-stretch rounded-md border bg-background/95 shadow-md backdrop-blur"
          >
            {canReplace && (
              <button
                type="button"
                aria-label={t("replay.replaceToggle", { key: replaceChordLabel })}
                aria-expanded={replaceOpen}
                title={t("replay.replaceToggle", { key: replaceChordLabel })}
                onClick={toggleReplace}
                className="flex w-5 shrink-0 items-start justify-center rounded-l-md pt-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {replaceOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            )}
            <div className={cn("flex flex-col gap-1 py-1 pr-1", canReplace ? "pl-1" : "pl-1.5")}>
              <div className="flex items-center gap-0.5">
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                    }
                  }}
                  placeholder={t("replay.searchPlaceholder")}
                  aria-label={t("replay.searchPlaceholder")}
                  className={FIND_FIELD}
                />
                <span
                  className={cn(
                    "w-12 select-none whitespace-nowrap px-1 text-center text-[10px] tabular-nums",
                    trimmedQuery && matchIds.length === 0 ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {trimmedQuery
                    ? `${matchIds.length === 0 ? 0 : Math.min(matchIdx, matchIds.length - 1) + 1}/${matchIds.length}`
                    : ""}
                </span>
                <FindIconButton
                  label={t("replay.searchPrev")}
                  disabled={matchIds.length === 0}
                  onClick={() => stepMatch(-1)}
                >
                  <ArrowUp className="size-3.5" />
                </FindIconButton>
                <FindIconButton
                  label={t("replay.searchNext")}
                  disabled={matchIds.length === 0}
                  onClick={() => stepMatch(1)}
                >
                  <ArrowDown className="size-3.5" />
                </FindIconButton>
                <FindIconButton label={t("replay.searchClose")} onClick={closeSearch}>
                  <X className="size-3.5" />
                </FindIconButton>
              </div>
              {canReplace && replaceOpen && (
                <div className="flex items-center gap-0.5">
                  <input
                    ref={replaceInputRef}
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        // ⌘/Ctrl+Enter replaces everything; plain Enter, this one.
                        if (e.metaKey || e.ctrlKey) replaceAll();
                        else replaceCurrent();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder={t("replay.replacePlaceholder")}
                    aria-label={t("replay.replacePlaceholder")}
                    className={FIND_FIELD}
                  />
                  <FindIconButton
                    label={t("replay.replaceOneTip")}
                    disabled={replaceDisabled}
                    onClick={replaceCurrent}
                  >
                    <Replace className="size-3.5" />
                  </FindIconButton>
                  <FindIconButton
                    label={t("replay.replaceAllTip", { count: occurrenceCount, key: modChordCap("Enter") })}
                    disabled={replaceDisabled}
                    onClick={replaceAll}
                  >
                    <ReplaceAll className="size-3.5" />
                  </FindIconButton>
                </div>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            // The handler above takes ⌘F or Ctrl+F; only this label used to
            // claim ⌘F on every platform.
            aria-label={t("replay.searchOpen", { key: modChordCap("F") })}
            title={t("replay.searchOpen", { key: modChordCap("F") })}
            onClick={openSearch}
            className="absolute right-3 top-2 z-10 grid size-7 place-items-center rounded-md border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
          >
            <Search className="size-3.5" />
          </button>
        ))}
      <ScrollArea className="h-full">
        <div ref={listRef} className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-4">
          {outputsStale && (
            // Same weight as the timing note below; pr-10 clears the search button.
            <div
              role="note"
              className="mb-1 flex items-baseline gap-2 border-b border-border pb-2 pl-2 pr-10 text-xs text-muted-foreground"
            >
              <span className="min-w-0">{t("replay.transcriptEdited")}</span>
              <button
                type="button"
                disabled={regenLocked}
                onClick={() => setRegenConfirming(true)}
                className="shrink-0 font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
              >
                {t("replay.transcriptEditedRegen")}
              </button>
            </div>
          )}
          {timingEstimated && (
            // pr-10 keeps the text clear of the floating search button.
            <div
              role="note"
              className="mb-1 border-b border-border pb-2 pl-2 pr-10 text-xs text-muted-foreground"
            >
              {t("replay.timingEstimated")}
            </div>
          )}
          {rows.map((seg, i) => {
            const masked = !preview && seg.startMs > playheadMs;
            const trimmed = isTrimmed(seg, trim);
            // Highlight the playing line even in preview (the wizard trim step plays
            // audio) — but not when there's no playback (review step: playheadMs=0).
            const active = seg.id === activeId && (!preview || playheadMs > 0);
            const isCurrentMatch = searching && seg.id === currentMatchId;
            const showBadge = i === 0 || speakerLabel(seg, speakerNames) !== speakerLabel(rows[i - 1], speakerNames);
            const key = speakerKey(seg);
            return (
              <div
                key={seg.id}
                ref={(el) => {
                  rowRefs.current[seg.id] = el;
                }}
                className={cn(
                  "group flex w-full cursor-pointer select-text gap-2.5 rounded-md px-2 py-1.5 text-left text-sm leading-6 transition-colors",
                  "hover:bg-muted/60",
                  active && "bg-primary/10",
                  isCurrentMatch && "ring-1 ring-warning-border",
                  pulsing && i === 0 && "ob-soft-pulse bg-primary/10 ring-1 ring-primary/30",
                  masked && "opacity-35",
                  trimmed && "opacity-50"
                )}
              >
                <button
                  type="button"
                  onClick={() => seekToLine(seg.startMs)}
                  className="mt-0.5 w-9 shrink-0 select-none text-right text-[11px] tabular-nums text-muted-foreground"
                >
                  {formatClock(seg.startMs)}
                </button>
                <div className="flex min-w-0 flex-1 flex-col items-start">
                  {showBadge &&
                    (editingKey === key ? (
                      <SpeakerNameInput
                        defaultValue={speakerNames[key] ?? ""}
                        placeholder={defaultSpeakerLabel(seg)}
                        onCommit={(name) => {
                          setSpeakerName(key, name);
                          setEditingKey(null);
                        }}
                        onCancel={() => setEditingKey(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        title={speakerLabel(seg, speakerNames)}
                        onClick={(e) => {
                          // Don't let the rename click also seek the row.
                          e.stopPropagation();
                          setEditingKey(key);
                        }}
                        className="cursor-text text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
                      >
                        {speakerLabel(seg, speakerNames)}
                      </button>
                    ))}
                  {/* A paragraph, not a button: WebKit will not drag-select text inside a
                      <button>, so wrapping the line in one meant the transcript could be
                      read but never highlighted and copied with ⌘C. Seeking by keyboard
                      goes through the timestamp button beside it; this is strictly the
                      pointer gesture — a primary-button release that did not end up
                      selecting text — so highlighting a line doesn't also jump the audio. */}
                  <p
                    onPointerUp={(e) => {
                      if (e.button !== 0 || isTextSelected(globalThis.getSelection())) return;
                      seekToLine(seg.startMs);
                    }}
                    className={cn(
                      "w-full min-w-0 select-text text-left",
                      active ? "text-foreground" : "text-foreground/90",
                      trimmed && "line-through"
                    )}
                  >
                    {searching ? highlightMatches(seg.text, trimmedQuery, isCurrentMatch) : seg.text}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {canReplace && <RegenAllSheet open={regenConfirming} onOpenChange={setRegenConfirming} />}
    </div>
  );
}

/** Where the floating "Replace…" sits (relative to the transcript's root) and
 *  the text it would prefill. */
interface SelectionAction {
  text: string;
  left: number;
  top: number;
}

/** Longest selection worth offering to replace: a misheard word or name, not a passage. */
const MAX_SELECTION_REPLACE = 80;

/**
 * The "Replace…" button for the current selection, or null: only for a
 * non-empty selection that lies inside the transcript list and stays on one
 * line (a find & replace works within a line, so a selection spanning two can
 * never match). Positioned centred just above the selection.
 */
function selectionActionFor(
  selection: Selection | null,
  list: HTMLElement | null,
  root: HTMLElement | null
): SelectionAction | null {
  if (!selection || !list || !root || !isTextSelected(selection) || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!list.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  if (!text || text.length > MAX_SELECTION_REPLACE || /[\r\n]/.test(text)) return null;
  const rect = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  // Never above the pane's top edge, where it would be clipped away.
  const top = Math.max(rect.top - box.top - 6, 30);
  return { text, left: rect.left + rect.width / 2 - box.left, top };
}

/**
 * Wrap every case-insensitive occurrence of `query` in a <mark>. Marks on the
 * current match row are stronger than on the other matching rows, the
 * same current-vs-rest convention as a browser's find bar.
 */
function highlightMatches(text: string, query: string, current: boolean): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
    if (at > from) parts.push(text.slice(from, at));
    from = at + q.length;
    parts.push(
      <mark
        key={at}
        className={cn(
          "rounded-[2px] text-inherit",
          current ? "bg-warning-border" : "bg-warning"
        )}
      >
        {text.slice(at, from)}
      </mark>
    );
  }
  if (parts.length === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Inline editor for a speaker's name. Commits on Enter or blur, cancels on Escape.
 * Stops click/keydown from bubbling so editing never triggers a row seek.
 */
function SpeakerNameInput({
  defaultValue,
  placeholder,
  onCommit,
  onCancel,
}: Readonly<{
  defaultValue: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      defaultValue={defaultValue}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      className="mb-0.5 h-5 w-28 rounded-md border border-input bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

/** A find/replace query field: bordered like VS Code's, so the two rows read
 *  as two inputs and line up. */
const FIND_FIELD =
  "h-6 w-44 rounded border border-input bg-background px-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary";

/** One icon action in the find bar, named by its tooltip (and aria-label). */
function FindIconButton({
  label,
  disabled = false,
  onClick,
  children,
}: Readonly<{ label: string; disabled?: boolean; onClick: () => void; children: ReactNode }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  );
}
