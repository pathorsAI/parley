import { useEffect, useRef, useState } from "react";
import { ArrowUp, CalendarDays, FileText, GripVertical, Loader2, Minus, Pause, Play, Square, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { useMeetingElapsed } from "../../lib/meeting/elapsed";
import { cancelActiveMeeting, endMeeting, toggleMeetingPause } from "../../lib/meeting/controls";
import { useCommandShortcut } from "../../lib/commands/bind";
import { isTauri } from "../../lib/platform";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import { CancelMeetingDialog } from "../TitleBar";
import { MicChip } from "../MicChip";
import { TranscriptPanel } from "../TranscriptPanel";
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

async function withWindow(action: "minimize" | "resize") {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (action === "minimize") await win.minimize();
    else await win.startResizeDragging("SouthEast");
  } catch (error) {
    log.warn("meeting: floating window action failed", { action, error: String(error) });
  }
}

/** Title bar: drag handle, the recording clock, the mic, minimize and close. */
function FloatingTitleBar({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useI18n();
  const status = useStore((s) => s.meetingStatus);
  const startedAt = useStore((s) => s.meetingStartedAt);
  const paused = status === "paused";
  const elapsed = useMeetingElapsed(status === "recording" || paused, paused, startedAt);

  return (
    <header
      data-tauri-drag-region
      className="flex h-[50px] shrink-0 items-center gap-2.5 border-b pl-4 pr-3"
    >
      <GripVertical aria-hidden className="pointer-events-none size-3.5 text-muted-foreground/70" />
      <span
        className={`pointer-events-none inline-flex items-center gap-2 rounded-full px-3 py-1 ${
          paused ? "bg-warning text-warning-foreground" : "bg-recording/10 text-recording"
        }`}
      >
        <span
          aria-hidden
          className={`size-2 rounded-full ${paused ? "bg-warning-foreground" : "animate-pulse bg-recording"}`}
        />
        <span className="font-display text-sm font-semibold tabular-nums">{elapsed}</span>
        {paused && <span className="text-xs font-medium">{t("titlebar.paused")}</span>}
      </span>
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <MicChip />
      <div className="flex items-center gap-1 pl-2">
        <button
          type="button"
          aria-label={t("titlebar.minimizeWindow")}
          title={t("titlebar.minimizeWindow")}
          onClick={() => void withWindow("minimize")}
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
      className="block size-full resize-none bg-transparent p-5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground"
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

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <FloatingTitleBar onClose={() => setConfirmCancel(true)} />
      <LiveBanners />
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
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-muted/50">
            {tab === "transcript" && <TranscriptPanel variant="floating" />}
            {tab === "notes" && <NotesPad />}
            {tab === "coach" && (
              <CoachFeed onSeek={setHighlightMs} askBar={false} emptyText={t("floating.coachEmpty")} />
            )}
          </div>
        </div>
      </div>

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
          void withWindow("resize");
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
