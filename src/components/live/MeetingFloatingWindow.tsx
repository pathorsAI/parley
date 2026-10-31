import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  CalendarDays,
  Captions,
  FileText,
  GripVertical,
  Loader2,
  Maximize2,
  MessageCircle,
  Minus,
  NotebookPen,
  Pause,
  Play,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useStore } from "../../lib/store";
import {
  COMPACT_BELOW,
  FLOATING_SIZE,
  MINI_HEIGHT,
  dragWindowFrom,
  setMeetingMini,
  setMiniHeight,
  useMiniDocking,
} from "../../lib/meeting/floatingWindow";
import { useMeetingElapsed } from "../../lib/meeting/elapsed";
import { meetingCommand } from "../../lib/meeting/meetingWindow";
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

/** The transcript's last few lines, oldest first, for the mini window. */
function MiniTranscript() {
  const { t } = useI18n();
  const segments = useStore((s) => s.segments);
  const names = useStore((s) => s.speakerNames);
  const endRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    () =>
      segments
        .filter((s) => s.text.trim())
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
        .slice(-4),
    [segments],
  );
  const lastText = lines.length ? lines[lines.length - 1].text : "";
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, lastText]);

  if (!lines.length) {
    return <p className="px-3 py-2.5 text-sm text-muted-foreground">{t("meeting.listening")}</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {lines.map((seg) => (
        <p key={seg.id} className="text-sm leading-[22px] text-foreground">
          <span className="mr-1.5 text-xs font-semibold text-primary">{speakerLabel(seg, names, t)}</span>
          {seg.text}
        </p>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/** The mini window's notes: the same notes as the 筆記 tab, in a small box. */
function MiniNotes() {
  const { t } = useI18n();
  const notes = useStore((s) => s.meetingNotes);
  const setNotes = useStore((s) => s.setMeetingNotes);
  return (
    <textarea
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      placeholder={t("floating.notesPlaceholder")}
      aria-label={t("floating.tabs.notes")}
      className="block min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-[22px] text-foreground outline-none placeholder:text-muted-foreground"
    />
  );
}

const MINI_TABS: { tab: Tab; icon: typeof Captions }[] = [
  { tab: "transcript", icon: Captions },
  { tab: "notes", icon: NotebookPen },
  { tab: "coach", icon: Sparkles },
];

/**
 * The mini window ("小窗"): the window shrunk to one row — the clock, the
 * three tabs as icons, expand — over a small view of the tab it shrank from:
 * the transcript's last lines, the notes box, or the coach's ask box (its
 * answer opens under the row). The window's height follows the tab. Dragged
 * from anywhere that is not a control; brought near the screen's top edge,
 * it snaps under the notch like a magnet.
 *
 * `fixed`: the full window dragged small shows this view too, at the size it
 * was dragged to — so the window is never resized under the user.
 */
function MiniWindow({
  tab,
  onTab,
  onExpand,
  fixed = false,
}: Readonly<{ tab: Tab; onTab: (tab: Tab) => void; onExpand: () => void; fixed?: boolean }>) {
  const { t } = useI18n();
  const cards = useCoachAsk((s) => s.cards);
  const ask = useCoachAsk((s) => s.ask);
  const busy = cards.some((c) => c.busy);
  const last = cards.length ? cards[cards.length - 1] : null;
  const [draft, setDraft] = useState("");
  const [idx, setIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const presets = ASK_SUGGESTIONS.map((k) => t(k));
  const coach = tab === "coach";
  const answerOpen = coach && open && !!last;
  useMiniDocking(!fixed);

  // Only a change of tab or answer resizes the window: on mount it already has
  // the size the shrink gave it, and resizing then raced the shrink's reading
  // of the size to restore later.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!fixed) void setMiniHeight(miniHeight(tab, answerOpen));
  }, [tab, answerOpen, fixed]);

  function send() {
    if (!draft.trim() || busy) return;
    void ask(draft);
    setDraft("");
    setIdx(-1);
    setOpen(true);
  }

  // ↑ ↓ walk the quick questions into the box; Enter asks.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = idx < 0 ? (step > 0 ? 0 : presets.length - 1) : (idx + step + presets.length) % presets.length;
    setIdx(next);
    setDraft(presets[next]);
  }

  return (
    <div
      role="dialog"
      aria-label={t("floating.mini")}
      onMouseDown={(e) => dragWindowFrom(e)}
      className="flex h-full min-h-0 w-full flex-1 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 pr-1.5 pl-2" title={fixed ? undefined : t("floating.dockHint")}>
        <RecordingClock withLabel={false} />
        {coach ? (
          <form
            className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg border border-input bg-background pr-1 pl-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setIdx(-1);
              }}
              onKeyDown={onKeyDown}
              aria-label={t("feed.askPlaceholder")}
              placeholder={t("floating.capsuleAsk")}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              aria-label={t("floating.send")}
              disabled={busy || !draft.trim()}
              className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <ArrowUp className="size-3" />}
            </button>
          </form>
        ) : (
          <div className="h-full min-w-0 flex-1" />
        )}
        {coach && last && !open && (
          <button
            type="button"
            aria-label={t("floating.showAnswer")}
            title={t("floating.showAnswer")}
            onClick={() => setOpen(true)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/80 transition-colors hover:bg-muted"
          >
            <MessageCircle className="size-3.5" />
          </button>
        )}
        <div role="tablist" aria-label={t("floating.tabsLabel")} className="flex shrink-0 items-center rounded-lg bg-muted/50 p-0.5">
          {MINI_TABS.map(({ tab: k, icon: Icon }) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              aria-label={t(`floating.tabs.${k}`)}
              title={t(`floating.tabs.${k}`)}
              onClick={() => onTab(k)}
              className={`grid size-7 place-items-center rounded-md transition-colors ${
                tab === k ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("floating.expand")}
          title={t("floating.expand")}
          onClick={onExpand}
          className="grid size-8 shrink-0 place-items-center rounded-md text-foreground/80 transition-colors hover:bg-muted"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      {tab === "transcript" && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <MiniTranscript />
        </div>
      )}
      {tab === "notes" && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <MiniNotes />
        </div>
      )}
      {answerOpen && last && (
        <div className="relative flex min-h-0 flex-1 flex-col border-t">
          <button
            type="button"
            aria-label={t("floating.hideAnswer")}
            title={t("floating.hideAnswer")}
            onClick={() => setOpen(false)}
            className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
          >
            <X className="size-3.5" />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 pr-8">
            <p className="mb-1 flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageCircle className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0">{last.question}</span>
            </p>
            {last.answer ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{last.answer}</ReactMarkdown>
              </div>
            ) : (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The mini window's height for `tab`, with the coach's answer open or not. */
function miniHeight(tab: Tab, answerOpen = false): number {
  if (tab === "coach") return answerOpen ? MINI_HEIGHT.coachAnswer : MINI_HEIGHT.coach;
  return MINI_HEIGHT[tab];
}

/** Title bar: drag handle, the recording clock, the mic, collapse and close. */
function FloatingTitleBar({
  onClose,
  onCollapse,
}: Readonly<{ onClose: () => void; onCollapse: () => void }>) {
  const { t } = useI18n();

  return (
    <header
      onMouseDown={(e) => dragWindowFrom(e)}
      className="flex h-[50px] shrink-0 items-center gap-2.5 border-b pl-4 pr-3"
    >
      <GripVertical aria-hidden className="pointer-events-none size-3.5 text-muted-foreground/70" />
      <RecordingClock />
      <div className="h-full min-w-0 flex-1" />
      <MicChip />
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
  const [mini, setMini] = useState(false);
  const compact = useCompact();
  const busyRef = useRef(false);
  const meetingActive = status === "recording" || status === "paused";
  const paused = status === "paused";

  // Each meeting starts with an empty question thread.
  useEffect(() => {
    useCoachAsk.getState().reset();
  }, [liveMeetingId]);

  const togglePause = () => meetingCommand("togglePause");
  useCommandShortcut("meeting.togglePause", togglePause, { enabled: meetingActive });

  /** End / cancel run in the main window (it records); send each once. */
  function once(cmd: "end" | "cancel") {
    if (busyRef.current) return;
    busyRef.current = true;
    meetingCommand(cmd);
  }
  // A new meeting in the same window can be ended again.
  useEffect(() => {
    busyRef.current = false;
  }, [liveMeetingId]);

  /** Resize first, then swap the view: the window is measured (on the way
   *  in) before anything shrinks it, and the full layout never renders into
   *  a mini-sized window on the way out. */
  async function toggleMini(on: boolean) {
    await setMeetingMini(on, miniHeight(tab));
    setMini(on);
  }

  /** Out of the full window dragged small: back to the frame's size. */
  async function growFromCompact() {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setSize(new LogicalSize(FLOATING_SIZE.width, FLOATING_SIZE.height));
    } catch (error) {
      log.warn("meeting: floating window grow failed", { error: String(error) });
    }
  }

  if (mini) return <MiniWindow tab={tab} onTab={setTab} onExpand={() => void toggleMini(false)} />;
  if (compact) return <MiniWindow fixed tab={tab} onTab={setTab} onExpand={() => void growFromCompact()} />;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <FloatingTitleBar onClose={() => setConfirmCancel(true)} onCollapse={() => void toggleMini(true)} />
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

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
        {/* 暫停 wears the paused pill's orange; once paused, 繼續 is the blue
            way back into the recording. */}
        <button
          type="button"
          onClick={togglePause}
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
          onClick={() => once("end")}
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
            once("cancel");
          }}
        />
      )}
    </div>
  );
}
