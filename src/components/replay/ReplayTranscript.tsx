import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "../../i18n";
import { speakerBadgeClass } from "../../lib/speakerColors";
import { speakerLabel, speakerKey, defaultSpeakerLabel, formatClock, isTrimmed, useStore, type ReplayTrim } from "../../lib/store";
import { cn } from "@/lib/utils";
import type { TranscriptSegment } from "../../lib/types";

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
 */
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

  // Ctrl/⌘F-style find: a floating bar over the transcript. A "match" is a LINE
  // (segment) whose text contains the query — Enter/arrows jump line-to-line and
  // the counter reads "current / total lines".
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);

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
    setQuery("");
    setMatchIdx(0);
  }

  function stepMatch(dir: 1 | -1) {
    if (matchIds.length === 0) return;
    setMatchIdx((i) => (Math.min(i, matchIds.length - 1) + dir + matchIds.length) % matchIds.length);
  }

  // ⌘F / Ctrl+F opens (or refocuses) the find bar. Not in the ingest-wizard
  // preview, where the transcript is a secondary pane.
  useEffect(() => {
    if (preview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);

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
    <div className="relative h-full">
      {!preview &&
        (searchOpen ? (
          <div className="absolute right-3 top-2 z-10 flex items-center gap-0.5 rounded-md border bg-background/95 py-1 pl-2 pr-1 shadow-md backdrop-blur">
            <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
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
              className="h-6 w-40 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground/60"
            />
            {trimmedQuery && (
              <span
                className={cn(
                  "select-none whitespace-nowrap px-1 font-mono text-[10px] tabular-nums",
                  matchIds.length === 0 ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {matchIds.length === 0 ? 0 : Math.min(matchIdx, matchIds.length - 1) + 1}/{matchIds.length}
              </span>
            )}
            <button
              type="button"
              aria-label={t("replay.searchPrev")}
              title={t("replay.searchPrev")}
              disabled={matchIds.length === 0}
              onClick={() => stepMatch(-1)}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("replay.searchNext")}
              title={t("replay.searchNext")}
              disabled={matchIds.length === 0}
              onClick={() => stepMatch(1)}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <ChevronDown className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("replay.searchClose")}
              title={t("replay.searchClose")}
              onClick={closeSearch}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label={t("replay.searchOpen")}
            title={t("replay.searchOpen")}
            onClick={openSearch}
            className="absolute right-3 top-2 z-10 grid size-7 place-items-center rounded-md border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
          >
            <Search className="size-3.5" />
          </button>
        ))}
      <ScrollArea className="h-full">
        <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-4">
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
                  active && "bg-primary/10 ring-1 ring-primary/30",
                  isCurrentMatch && "ring-1 ring-amber-400/70",
                  masked && "opacity-35",
                  trimmed && "opacity-50"
                )}
              >
                <button
                  type="button"
                  onClick={() => onSeek(seg.startMs)}
                  className="mt-0.5 w-9 shrink-0 select-none text-right font-mono text-[10px] tabular-nums text-muted-foreground"
                >
                  {formatClock(seg.startMs)}
                </button>
                <span className="flex min-w-0 flex-1 items-start">
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
                        className={cn(
                          "mr-1.5 inline-flex translate-y-[-1px] cursor-text items-center rounded-md px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide ring-1 hover:ring-2",
                          speakerBadgeClass(seg)
                        )}
                      >
                        {speakerLabel(seg, speakerNames)}
                      </button>
                    ))}
                  <button
                    type="button"
                    onClick={() => onSeek(seg.startMs)}
                    className={cn(
                      "min-w-0 flex-1 text-left",
                      active ? "text-foreground" : "text-foreground/90",
                      trimmed && "line-through"
                    )}
                  >
                    {searching ? highlightMatches(seg.text, trimmedQuery, isCurrentMatch) : seg.text}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Wrap every case-insensitive occurrence of `query` in a <mark>. Marks on the
 * current match row are stronger (amber) than on the other matching rows, the
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
          current ? "bg-amber-400/80 dark:bg-amber-400/50" : "bg-yellow-300/50 dark:bg-yellow-400/25"
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
      className="mr-1.5 inline-flex h-5 w-28 translate-y-[-1px] rounded-md border border-input bg-background px-1.5 align-middle text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
