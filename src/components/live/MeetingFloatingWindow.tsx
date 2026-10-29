import { useEffect, useRef, useState } from "react";
import { ArrowUp, CalendarDays, FileText, GripVertical, Loader2, Maximize2, Minus, Pause, Play, Square, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { COMPACT_BELOW, setMeetingPill } from "../../lib/meeting/floatingWindow";
import { useMeetingElapsed } from "../../lib/meeting/elapsed";
import { cancelActiveMeeting, endMeeting, toggleMeetingPause } from "../../lib/meeting/controls";
import { useCommandShortcut } from "../../lib/commands/bind";
import { isTauri } from "../../lib/platform";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import { CancelMeetingDialog } from "../TitleBar";
import { MicChip } from "../MicChip";
import { speakerLabel, TranscriptPanel } from "../TranscriptPanel";
import { DestinationField } from "../DestinationSheet";
import { MeetingContextField } from "../MeetingContextField";
import { useMeetingDestination } from "../useMeetingDestination";
import { CoachFeed } from "./CoachFeed";
import { LiveBanners } from "./LiveScreen";
import { ASK_SUGGESTIONS, useCoachAsk } from "./coachAsk";

type Tab = "notes" | "transcript" | "coach";

/** 2026/10/30 — the meeting's day, in the frame's numeric form. */
function meetingDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

async function startResize() {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startResizeDragging("SouthEast");
  } catch (error) {
    log.warn("meeting: floating window resize failed", { error: String(error) });
  }
}

/** True while the window is dragged smaller than the full layout fits. */
function useCompact(): boolean {
  const measure = () =>
    globalThis.innerWidth < COMPACT_BELOW.width || globalThis.innerHeight < COMPACT_BELOW.height;
  const [compact, setCompact] = useState(measure);
  useEffect(() => {
    const onResize = () => setCompact(measure());
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

/** The recording clock: red dot + elapsed, orange with 已暫停 while paused. */
function RecordingClock({ withLabel = true }: Readonly<{ withLabel?: boolean }>) {
  const { t } = useI18n();
  const status = useStore((s) => s.meetingStatus);
  const startedAt = useStore((s) => s.meetingStartedAt);
  const paused = status === "paused";
  const elapsed = useMeetingElapsed(status === "recording" || paused, paused, startedAt);
  return (
    <span
      className={`pointer-events-none inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 ${
        paused ? "bg-warning text-warning-foreground" : "bg-recording/10 text-recording"
      }`}
    >
      <span
        aria-hidden
        className={`size-2 rounded-full ${paused ? "bg-warning-foreground" : "animate-pulse bg-recording"}`}
      />
      <span className="font-display text-sm font-semibold tabular-nums">{elapsed}</span>
      {paused && withLabel && <span className="text-xs font-medium">{t("titlebar.paused")}</span>}
    </span>
  );
}

/** The coach's latest word: the last answer, else the newest finding, else
 *  how to ask. One line of it rides in the capsule and the compact view. */
function useCoachTip(): string {
  const { t } = useI18n();
  const lastAnswer = useCoachAsk((s) => {
    for (let i = s.cards.length - 1; i >= 0; i--) if (s.cards[i].answer.trim()) return s.cards[i].answer;
    return "";
  });
  const lastFinding = useStore((s) => s.findings[s.findings.length - 1]?.title ?? "");
  const text = lastAnswer || lastFinding;
  // Answers are markdown; the tip is one plain line.
  return text ? text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim() : t("floating.coachTipEmpty");
}

/** The latest transcript line, for the compact view. */
function useLatestLine(): { name: string; text: string } | null {
  const { t } = useI18n();
  const names = useStore((s) => s.speakerNames);
  const last = useStore((s) => {
    let best: (typeof s.segments)[number] | null = null;
    for (const seg of s.segments) if (seg.text.trim() && (!best || seg.startMs >= best.startMs)) best = seg;
    return best;
  });
  return last ? { name: speakerLabel(last, names, t), text: last.text } : null;
}

/** Compact view: the window dragged small keeps only the latest line and the
 *  coach's tip between the title bar and the bottom bar. */
function CompactBody() {
  const { t } = useI18n();
  const line = useLatestLine();
  const tip = useCoachTip();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
      <div className="flex min-h-0 flex-col gap-0.5">
        {line ? (
          <>
            <span className="text-xs font-semibold text-primary">{line.name}</span>
            <span className="line-clamp-4 text-sm leading-[22px] text-foreground">{line.text}</span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{t("meeting.listening")}</span>
        )}
      </div>
      <div className="line-clamp-3 shrink-0 rounded-lg border border-warning-border bg-warning px-2.5 py-1.5 text-xs leading-normal text-warning-foreground">
        {tip}
      </div>
    </div>
  );
}

/** The capsule ("小膠囊"): the whole window collapsed to clock + coach tip. */
function MeetingCapsule({ onExpand }: Readonly<{ onExpand: () => void }>) {
  const { t } = useI18n();
  const tip = useCoachTip();
  return (
    <div
      role="dialog"
      aria-label={t("floating.capsule")}
      data-tauri-drag-region
      className="flex h-full w-full items-center gap-2.5 rounded-full border bg-background pr-1.5 pl-2"
    >
      <RecordingClock withLabel={false} />
      <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-xs text-warning-foreground">
        {tip}
      </span>
      <button
        type="button"
        aria-label={t("floating.expand")}
        title={t("floating.expand")}
        onClick={onExpand}
        className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-muted"
      >
        <Maximize2 className="size-3.5" />
      </button>
    </div>
  );
}

/** Title bar: drag handle, the recording clock, the mic, collapse and close. */
function FloatingTitleBar({
  onClose,
  onCollapse,
  compact,
}: Readonly<{ onClose: () => void; onCollapse: () => void; compact: boolean }>) {
  const { t } = useI18n();

  return (
    <header
      data-tauri-drag-region
      className="flex h-[50px] shrink-0 items-center gap-2.5 border-b pl-4 pr-3"
    >
      <GripVertical aria-hidden className="pointer-events-none size-3.5 text-muted-foreground/70" />
      <RecordingClock />
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      {!compact && <MicChip />}
      <div className="flex items-center gap-1 pl-2">
        <button
          type="button"
          aria-label={t("floating.collapse")}
          title={t("floating.collapse")}
          onClick={onCollapse}
          className="grid size-8 place-items-center rounded-md text-foreground/80 transition-colors hover:bg-muted"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.cancelMeeting")}
          title={t("titlebar.cancelMeeting")}
          onClick={onClose}
          className="grid size-8 place-items-center rounded-md text-foreground/80 transition-colors hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}

/** The meeting's name, day and folder, under the title bar. */
function MeetingHeading() {
  const { t } = useI18n();
  const title = useStore((s) => s.meetingTitle);
  const setTitle = useStore((s) => s.setMeetingTitle);
  const startedAt = useStore((s) => s.meetingStartedAt);
  const { destination, mode, fresh, pickDestination } = useMeetingDestination();

  return (
    <div className="flex shrink-0 flex-col gap-2 px-5 pt-5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("floating.untitled")}
        aria-label={t("floating.titleLabel")}
        className="w-full min-w-0 bg-transparent text-2xl leading-[1.6] text-foreground outline-none placeholder:text-foreground/40"
      />
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 items-center gap-2 rounded-md bg-muted/30 px-2 text-xs text-primary">
          <CalendarDays className="size-3" />
          {meetingDate(startedAt ?? Date.now())}
        </span>
        <DestinationField
          gateOnSync
          verb="save"
          title={t("dest.title.save")}
          value={destination}
          mode={mode}
          fresh={fresh}
          onChange={pickDestination}
          chip={{ empty: t("floating.addFolder") }}
        />
      </div>
    </div>
  );
}

/** 筆記: a plain text box — write whatever, however. Saved with the recording
 *  as part of its context. */
function NotesPad() {
  const { t } = useI18n();
  const notes = useStore((s) => s.meetingNotes);
  const setNotes = useStore((s) => s.setMeetingNotes);
  return (
    <textarea
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      placeholder={t("floating.notesPlaceholder")}
      aria-label={t("floating.tabs.notes")}
      className="block size-full resize-none bg-transparent p-5 text-sm leading-[22px] text-foreground outline-none placeholder:text-muted-foreground"
    />
  );
}

/** One tab of the segmented strip: the selected one rises into the panel. */
function TabButton({
  active,
  label,
  onClick,
}: Readonly<{ active: boolean; label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 text-sm transition-colors ${
        active
          ? "rounded-t-lg bg-muted/50 pt-3 pb-4 font-bold text-primary"
          : "rounded-[9px] pt-3 pb-3.5 font-medium text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The bottom bar's ask box. Focusing it offers the quick questions; ↑ ↓ walk
 * them, Enter asks the highlighted one (or what was typed), Esc closes them.
 */
function AskBox({ onAsked }: Readonly<{ onAsked: () => void }>) {
  const { t } = useI18n();
  const ask = useCoachAsk((s) => s.ask);
  const busy = useCoachAsk((s) => s.cards.some((c) => c.busy));
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const presets = ASK_SUGGESTIONS.map((k) => t(k));
  const showPresets = open && !draft;

  function send(q: string) {
    if (!q.trim() || busy) return;
    void ask(q);
    setDraft("");
    setOpen(false);
    setIdx(-1);
    onAsked();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setIdx(-1);
      return;
    }
    if (draft) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIdx((i) => (i < 0 ? (step > 0 ? 0 : presets.length - 1) : (i + step + presets.length) % presets.length));
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      send(presets[idx]);
    }
  }

  return (
    <form
      className="relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background pr-1 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        send(draft);
      }}
    >
      {showPresets && (
        <div
          role="listbox"
          aria-label={t("floating.presetsLabel")}
          className="absolute right-0 bottom-full left-0 mb-2 flex flex-col rounded-lg border bg-popover p-1 shadow-lg"
        >
          <span className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">{t("floating.presetsHint")}</span>
          {presets.map((q, i) => (
            <button
              key={q}
              type="button"
              role="option"
              aria-selected={i === idx}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                send(q);
              }}
              className={`rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                i === idx ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
              }`}
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setIdx(-1);
        }}
        onKeyDown={onKeyDown}
        aria-label={t("feed.askPlaceholder")}
        placeholder={t("floating.askPlaceholder")}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="submit"
        aria-label={t("floating.send")}
        disabled={busy || !draft.trim()}
        className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
      </button>
    </form>
  );
}

/**
 * The meeting, as the floating window the app becomes while it records
 * (useFloatingMeetingWindow): name and folder on top, notes / transcript /
 * coach in tabs, and pause, ask-the-coach and end along the bottom.
 */
export function MeetingFloatingWindow() {
  const { t } = useI18n();
  const status = useStore((s) => s.meetingStatus);
  const finalizing = useStore((s) => s.isFinalizingMeeting);
  const liveMeetingId = useStore((s) => s.liveMeetingId);
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const coachCount = useStore((s) => s.findings.length) + useCoachAsk((s) => s.cards.length);
  const [tab, setTab] = useState<Tab>("transcript");
  const [bgOpen, setBgOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pill, setPill] = useState(false);
  const compact = useCompact();
  const busyRef = useRef(false);
  const meetingActive = status === "recording" || status === "paused";
  const paused = status === "paused";

  // Each meeting starts with an empty question thread.
  useEffect(() => {
    useCoachAsk.getState().reset();
  }, [liveMeetingId]);

  useCommandShortcut("meeting.togglePause", toggleMeetingPause, { enabled: meetingActive });

  async function guarded(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await fn();
    } finally {
      busyRef.current = false;
    }
  }

  function togglePill(on: boolean) {
    setPill(on);
    void setMeetingPill(on);
  }

  if (pill) return <MeetingCapsule onExpand={() => togglePill(false)} />;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <FloatingTitleBar
        compact={compact}
        onClose={() => setConfirmCancel(true)}
        onCollapse={() => togglePill(true)}
      />
      <LiveBanners />
      {compact ? (
        <CompactBody />
      ) : (
        <>
          <MeetingHeading />

          {bgOpen && (
            <div className="mx-5 mt-4 flex shrink-0 flex-col gap-2 rounded-lg border p-3">
              <span className="text-xs font-medium">{t("floating.backgroundLabel")}</span>
              <MeetingContextField rows={3} autoFocus />
              <button
                type="button"
                onClick={() => setBgOpen(false)}
                className="self-end rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                {t("floating.backgroundDone")}
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-start gap-2 px-4 pt-5">
              <div role="tablist" aria-label={t("floating.tabsLabel")} className="flex flex-1 self-stretch">
                <TabButton active={tab === "notes"} label={t("floating.tabs.notes")} onClick={() => setTab("notes")} />
                <TabButton
                  active={tab === "transcript"}
                  label={t("floating.tabs.transcript")}
                  onClick={() => setTab("transcript")}
                />
                <TabButton
                  active={tab === "coach"}
                  label={coachCount ? `${t("floating.tabs.coach")} ${coachCount}` : t("floating.tabs.coach")}
                  onClick={() => setTab("coach")}
                />
              </div>
              <button
                type="button"
                aria-label={t("floating.background")}
                title={t("floating.background")}
                aria-pressed={bgOpen}
                onClick={() => setBgOpen((v) => !v)}
                className={`grid size-9 shrink-0 place-items-center rounded-[10px] border transition-colors hover:bg-muted ${
                  bgOpen ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-foreground/80"
                }`}
              >
                <FileText className="size-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col px-4 pb-5">
              {/* 筆記 sits flush on the panel's left edge, so while it is the raised
                  tab that corner stays square and the two read as one surface. */}
              <div
                className={`min-h-0 flex-1 overflow-hidden rounded-lg bg-muted/50 ${
                  tab === "notes" ? "rounded-tl-none" : ""
                }`}
              >
                {tab === "transcript" && <TranscriptPanel variant="floating" />}
                {tab === "notes" && <NotesPad />}
                {tab === "coach" && (
                  <CoachFeed onSeek={setHighlightMs} askBar={false} emptyText={t("floating.coachEmpty")} />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
        {/* 暫停 wears the paused pill's orange; once paused, 繼續 is the blue
            way back into the recording. */}
        <button
          type="button"
          onClick={toggleMeetingPause}
          disabled={!meetingActive}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg pr-3 pl-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            paused
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-warning text-warning-foreground hover:bg-warning/80"
          }`}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {paused ? t("titlebar.resume") : t("titlebar.pause")}
        </button>
        <AskBox onAsked={() => setTab("coach")} />
        <button
          type="button"
          onClick={() => void guarded(endMeeting)}
          disabled={!meetingActive || finalizing}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg pr-3 pl-2.5 text-sm font-medium text-recording bg-recording/10 transition-colors hover:bg-recording/15 disabled:opacity-60"
        >
          {finalizing ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
          {t("titlebar.end")}
        </button>
      </footer>

      <button
        type="button"
        aria-label={t("floating.resize")}
        title={t("floating.resize")}
        onMouseDown={(e) => {
          e.preventDefault();
          void startResize();
        }}
        className="absolute right-1 bottom-1 size-3 cursor-se-resize text-muted-foreground/70"
      >
        <svg viewBox="0 0 10 10" aria-hidden className="size-full">
          <path d="M9 3 L3 9 M9 6.5 L6.5 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>

      {confirmCancel && (
        <CancelMeetingDialog
          t={t}
          onKeep={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false);
            void guarded(cancelActiveMeeting);
          }}
        />
      )}
    </div>
  );
}
