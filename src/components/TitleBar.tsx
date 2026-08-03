import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Building2, Check, ChevronDown, Circle, ClipboardList, Eraser, FileAudio, History, Languages, Loader2, LogOut, Mic, Minus, Pause, Pencil, Play, Settings, Square, X } from "lucide-react";
import { useStore, meetingElapsedMs, type AppMode } from "../lib/store";
import type { Settings as AppSettings } from "../lib/types";
import { log } from "../lib/log";
import { sttApiKey } from "../lib/transcription/providers";
import { toast } from "sonner";
import { stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { beginMeeting } from "../lib/meeting/start";
import { openSettings } from "../lib/nav";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LevelMeter } from "./LevelMeter";
import { McpStatusChip } from "./McpStatusChip";
import { TranslateMenu } from "./TranslateMenu";
import { ReplayFolderChip } from "./ReplayFolderChip";
import { PostMeetingReviewButton } from "./accounts/PostMeetingReviewButton";
import { StudyGenerationChip } from "./study/StudyGenerationChip";

const AccountsSheet = lazy(() =>
  import("./accounts/AccountsSheet").then((m) => ({ default: m.AccountsSheet }))
);

type TFn = ReturnType<typeof useI18n>["t"];
type WindowAction = "close" | "minimize" | "fullscreen";
type StudyTab = "report" | "replay";
type Layout = AppSettings["layout"];

/**
 * Track main-window focus so the traffic lights can dim to grey when the window
 * is inactive — matching native macOS behaviour. Defaults to focused (and stays
 * focused in browser dev, where there's no window to query).
 */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    async function connectFocusEvents() {
      const win = getCurrentWindow();
      try {
        const initial = await win.isFocused();
        if (active) setFocused(initial);
      } catch {
        /* ignore — keep default */
      }
      const un = await win.onFocusChanged(({ payload }) => {
        if (active) setFocused(payload);
      });
      if (active) unlisten = un;
      else un();
    }
    connectFocusEvents().catch((error) => log.warn("window: focus listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return focused;
}


function TrafficLights({
  focused,
  onAction,
  t,
}: Readonly<{
  focused: boolean;
  onAction: (action: WindowAction) => void;
  t: TFn;
}>) {
  const closeColor = focused ? "bg-[#FF5F57]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FF5F57] dark:bg-[#565658]";
  const minimizeColor = focused ? "bg-[#FEBC2E]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FEBC2E] dark:bg-[#565658]";
  const fullscreenColor = focused ? "bg-[#28C840]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#28C840] dark:bg-[#565658]";

  return (
    <div className="group/traffic absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2">
      <button
        type="button"
        aria-label={t("titlebar.closeWindow")}
        onClick={() => onAction("close")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${closeColor}`}
      >
        <X
          className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
          strokeWidth={3}
        />
      </button>
      <button
        type="button"
        aria-label={t("titlebar.minimizeWindow")}
        onClick={() => onAction("minimize")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${minimizeColor}`}
      >
        <Minus
          className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
          strokeWidth={3}
        />
      </button>
      <button
        type="button"
        aria-label={t("titlebar.fullscreenWindow")}
        onClick={() => onAction("fullscreen")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${fullscreenColor}`}
      >
        {/* Native zoom/fullscreen glyph: two filled triangles tucked into opposite corners. */}
        <svg
          viewBox="0 0 10 10"
          aria-hidden
          className="size-2 fill-current text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
        >
          <path d="M1.4 1.4H6L1.4 6Z" />
          <path d="M8.6 8.6H4L8.6 4Z" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The loaded recording's name at the leading edge of the titlebar, doubling as
 * an inline rename affordance (hover → pencil → input; Enter/blur commits,
 * Escape cancels — the same interaction as the History card). Rename persists to
 * disk + cloud + the History window via renameHistoryEntry, then updates the
 * header immediately via renameReplay. Only offered for recordings saved in the
 * local library; an unsaved upload or a read-only org recording (loadedHistoryId
 * null) renders the name read-only.
 */
function ReplayTitle({ t }: Readonly<{ t: TFn }>) {
  const replayName = useStore((s) => s.replay?.name ?? "");
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const renameReplay = useStore((s) => s.renameReplay);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(replayName);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(replayName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }
  async function commit() {
    setEditing(false);
    const clean = draft.trim();
    if (!clean || clean === replayName || !loadedHistoryId) return;
    try {
      const { renameHistoryEntry } = await import("../lib/history/history");
      await renameHistoryEntry(loadedHistoryId, clean);
      renameReplay(clean);
    } catch (e) {
      log.error("replay: rename failed", { error: String(e) });
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t("replay.renameFailed", { error: message }));
    }
  }

  if (editing) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400">
        <FileAudio className="size-3.5 shrink-0" />
        <input
          ref={inputRef}
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              void commit();
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              setDraft(replayName);
              setEditing(false);
            }
          }}
          onBlur={() => void commit()}
          className="h-6 w-44 min-w-0 rounded border bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
        />
        <button
          type="button"
          aria-label={t("history.renameSave")}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => void commit()}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          <Check className="size-3" />
        </button>
      </span>
    );
  }

  return (
    <span className="group/rename flex min-w-0 items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400">
      <FileAudio className="size-3.5 shrink-0" />
      <span className="max-w-44 truncate">{replayName}</span>
      {loadedHistoryId && (
        <button
          type="button"
          aria-label={t("replay.rename")}
          title={t("replay.rename")}
          onClick={startEdit}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/rename:opacity-100"
        >
          <Pencil className="size-3" />
        </button>
      )}
    </span>
  );
}

/**
 * Confirm dialog for CANCELLING a live meeting — the one destructive control
 * in the recorder cluster (transcript + recording are discarded, nothing is
 * saved or analyzed), so it never fires on a single click. Portal'd for the
 * same reason as MeetingContextDialog: the titlebar's backdrop-blur makes it
 * the containing block for fixed-position descendants.
 */
function CancelMeetingDialog({
  onConfirm,
  onKeep,
  t,
}: Readonly<{ onConfirm: () => void; onKeep: () => void; t: TFn }>) {
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <button
        type="button"
        aria-label={t("meeting.cancel.keep")}
        className="absolute inset-0 bg-black/50"
        onClick={onKeep}
      />
      <div className="relative w-full max-w-sm rounded-xl border bg-background p-4 shadow-xl">
        <h2 className="text-sm font-semibold text-foreground">{t("meeting.cancel.title")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("meeting.cancel.body")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" className="h-8" onClick={onKeep}>
            {t("meeting.cancel.keep")}
          </Button>
          <Button size="sm" variant="destructive" className="h-8" onClick={onConfirm}>
            {t("meeting.cancel.confirm")}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** One pill in the center switcher. */
function SwitchTab({
  active,
  accent = false,
  label,
  onClick,
}: Readonly<{ active: boolean; accent?: boolean; label: string; onClick: () => void }>) {
  const activeClass = accent
    ? "bg-background text-violet-600 shadow-sm dark:text-violet-400"
    : "bg-background text-foreground shadow-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active ? activeClass : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The center slot does ONE thing (R6): page tabs for a tense that has pages —
 * the live postures, or the study report/replay pair. Every other route
 * renders nothing here; "where am I" is the sidebar highlight + the tense
 * badge on the left, not a passive label in a control slot.
 */
function CenterSwitcher({
  mode,
  studyTab,
  layout,
  onStudyTab,
  onLayout,
  t,
}: Readonly<{
  mode: AppMode;
  studyTab: StudyTab;
  layout: Layout;
  onStudyTab: (tab: StudyTab) => void;
  onLayout: (layout: Layout) => void;
  t: TFn;
}>) {
  if (mode === "study") {
    return (
      <>
        {(["report", "replay"] as const).map((tab) => (
          <SwitchTab
            key={tab}
            accent
            active={studyTab === tab}
            label={t(`study.${tab}`)}
            onClick={() => onStudyTab(tab)}
          />
        ))}
      </>
    );
  }
  if (mode === "live") {
    return (
      <>
        {(["coach", "transcript"] as const).map((posture) => (
          <SwitchTab
            key={posture}
            active={layout === posture}
            label={t(`layout.${posture}`)}
            onClick={() => onLayout(posture)}
          />
        ))}
      </>
    );
  }
  return null;
}

/** Pause/resume ⇄, end (save → debrief), cancel (discard, confirm-gated). All
 *  three live in both states, so 繼續／結束／取消 are always at hand. */
function RecorderCluster({
  paused,
  busy,
  onTogglePause,
  onEnd,
  onRequestCancel,
  t,
}: Readonly<{
  paused: boolean;
  busy: boolean;
  onTogglePause: () => void;
  onEnd: () => void;
  onRequestCancel: () => void;
  t: TFn;
}>) {
  return (
    <>
      <Button
        size="sm"
        variant={paused ? "default" : "outline"}
        onClick={onTogglePause}
        // Held while a start/end/cancel invoke is in flight: pausing mid-start
        // could land set_meeting_paused BEFORE start_meeting resets the flag,
        // splitting UI and backend pause state.
        disabled={busy}
        className="h-8"
      >
        {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        {paused ? t("titlebar.resume") : t("titlebar.pause")}
      </Button>
      <Button size="sm" variant="destructive" onClick={onEnd} disabled={busy} className="h-8">
        <Square className="size-3.5" />
        {t("titlebar.end")}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        aria-label={t("titlebar.cancelMeeting")}
        title={t("titlebar.cancelMeeting")}
        disabled={busy}
        onClick={onRequestCancel}
      >
        <X className="size-4" />
      </Button>
    </>
  );
}

/**
 * The trailing action for the current tense — exactly one of: leave this mode,
 * drive the running recorder, wait out the post-stop save, or start.
 */
function PrimaryAction({
  mode,
  meetingActive,
  paused,
  finalizing,
  busy,
  hasPrepDraft,
  onExitReplay,
  onExitPreflight,
  onTogglePause,
  onEnd,
  onRequestCancel,
  onStart,
  onStartDirect,
  onResetPrep,
  t,
}: Readonly<{
  mode: AppMode;
  meetingActive: boolean;
  paused: boolean;
  finalizing: boolean;
  busy: boolean;
  hasPrepDraft: boolean;
  onExitReplay: () => void;
  onExitPreflight: () => void;
  onTogglePause: () => void;
  onEnd: () => void;
  onRequestCancel: () => void;
  onStart: () => void;
  onStartDirect: () => void;
  onResetPrep: () => void;
  t: TFn;
}>) {
  if (mode === "study") {
    return (
      <Button size="sm" variant="outline" onClick={onExitReplay} className="h-8">
        <LogOut className="size-3.5" />
        {t("replay.exit")}
      </Button>
    );
  }
  // "accounts" and "library" have no exit button: the tree beside them is
  // always on screen, so leaving is picking somewhere else (#195).
  if (mode === "preflight") {
    // Starting happens in the pre-flight footer, next to what it commits to;
    // up here there is only the way back out.
    return (
      <Button size="sm" variant="outline" onClick={onExitPreflight} className="h-8">
        <X className="size-3.5" />
        {t("preflight.exit")}
      </Button>
    );
  }
  if (meetingActive) {
    return (
      <RecorderCluster
        paused={paused}
        busy={busy}
        onTogglePause={onTogglePause}
        onEnd={onEnd}
        onRequestCancel={onRequestCancel}
        t={t}
      />
    );
  }
  if (finalizing) {
    // Post-"End" save window: the recording is encoding + persisting +
    // re-diarizing off-thread. Hold a disabled spinner here (not the Start
    // button) so the seconds-long wait doesn't read as a hang or a no-op.
    return (
      <Button size="sm" variant="default" disabled className="h-8">
        <Loader2 className="size-3.5 animate-spin" />
        {t("titlebar.finalizing")}
      </Button>
    );
  }
  // R3: two speeds out of one button. The main face opens pre-flight (the
  // prepared path, never destructive now); the chevron offers "start right
  // now" and — only when a draft exists — the ONE explicit way to clear it.
  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="default"
        onClick={onStart}
        disabled={busy}
        className="h-8 rounded-r-none"
      >
        <Mic className="size-3.5" />
        {t("titlebar.startMeeting")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="default"
            disabled={busy}
            aria-label={t("titlebar.startOptions")}
            className="h-8 w-6 rounded-l-none border-l border-primary-foreground/20"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onStartDirect}>
            <Play className="size-3.5" />
            <span className="flex flex-col">
              <span>{t("titlebar.startDirect")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t("titlebar.startDirectHint")}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onStart}>
            <ClipboardList className="size-3.5" />
            {t("titlebar.startPrepared")}
          </DropdownMenuItem>
          {hasPrepDraft && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onResetPrep} className="text-muted-foreground">
                <Eraser className="size-3.5" />
                {t("titlebar.resetPrep")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Custom window titlebar. The main Tauri window is undecorated, so this header
 * owns both the draggable region and the window controls.
 *
 * In fullscreen there are no window controls (macOS hides the traffic lights and
 * reveals its own menu bar at the top edge), so we drop our traffic lights and
 * let the logo + brand sit at the leading edge.
 */
export function TitleBar({ fullscreen = false }: Readonly<{ fullscreen?: boolean }>) {
  const { t } = useI18n();
  const focused = useWindowFocused();
  const status = useStore((s) => s.meetingStatus);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const stopMeeting = useStore((s) => s.stopMeeting);
  const isFinalizingMeeting = useStore((s) => s.isFinalizingMeeting);
  const setFinalizingMeeting = useStore((s) => s.setFinalizingMeeting);
  const pauseMeeting = useStore((s) => s.pauseMeeting);
  const resumeMeeting = useStore((s) => s.resumeMeeting);
  const cancelMeeting = useStore((s) => s.cancelMeeting);
  const translateEnabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const translateLanguage = useStore((s) => s.settings.translateTargetLanguage);
  const layout = useStore((s) => s.settings.layout);
  const updateSettings = useStore((s) => s.updateSettings);
  const meetingStartedAt = useStore((s) => s.meetingStartedAt);
  const studyTab = useStore((s) => s.studyTab);
  const setStudyTab = useStore((s) => s.setStudyTab);
  const [elapsed, setElapsed] = useState("00:00");
  const appMode = useStore((s) => s.appMode);
  const exitReplay = useStore((s) => s.exitReplay);
  const openAccounts = useStore((s) => s.openAccounts);
  const openLibrary = useStore((s) => s.openLibrary);
  const showReplay = useStore((s) => s.showReplay);
  const replayName = useStore((s) => s.replay?.name ?? null);
  const enterPreflight = useStore((s) => s.enterPreflight);
  const exitPreflight = useStore((s) => s.exitPreflight);
  const [accountsSheet, setAccountsSheet] = useState(false);
  const resetPrep = useStore((s) => s.resetPrep);
  // R3: a non-empty prep draft unlocks the explicit "clear prep" menu item.
  const hasPrepDraft = useStore(
    (s) =>
      !!s.meetingCompanyId ||
      !!s.meetingContext.trim() ||
      !!s.meetingTarget.trim() ||
      s.todos.length > 0
  );
  // Guard the start/stop toggle so a rapid double-click can't fire two overlapping
  // start/stop invokes (which is what could race two transcription sessions open,
  // or interleave a stop with a start). The ref blocks re-entry synchronously
  // (before any re-render); `toggleBusy` just disables the button visually.
  const toggleBusyRef = useRef(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const recording = status === "recording";
  const paused = status === "paused";
  // Recording OR paused: the meeting owns the session (recorder controls show).
  const meetingActive = recording || paused;
  const studyMode = appMode === "study";
  const accountsMode = appMode === "accounts";
  const preflightMode = appMode === "preflight";

  // Vitals timer (top-left): elapsed RECORDED time (wall time minus pauses —
  // matching the pause-compacted recording), ticking 1 Hz. While paused the
  // value is frozen, so ticking is pointless; the transition re-renders it once.
  useEffect(() => {
    if (!meetingActive) return;
    const tick = () => {
      const sec = Math.floor(meetingElapsedMs(useStore.getState()) / 1000);
      setElapsed(
        `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`
      );
    };
    tick();
    if (paused) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [meetingActive, paused, meetingStartedAt]);
  const useRealPipeline = isTauri() && !!sttKey.trim();

  /** Run `fn` under the shared re-entrancy guard: rapid clicks across the
   *  recorder controls (start/end/cancel) can't overlap two mutating invokes. */
  async function guarded(fn: () => Promise<void>) {
    if (toggleBusyRef.current) return;
    toggleBusyRef.current = true;
    setToggleBusy(true);
    try {
      await fn();
    } finally {
      toggleBusyRef.current = false;
      setToggleBusy(false);
    }
  }

  /** Start (prepared path) = open PRE-FLIGHT. Non-destructive since R3: an
   *  existing prep draft is picked up where it was left, never wiped. */
  function start() {
    enterPreflight();
  }

  /** Start (fast path, R3) = skip pre-flight and record right now, riding
   *  whatever prep draft / scenario is already set. Same gate-checked sequence
   *  as the pre-flight footer (lib/meeting/start), same re-entrancy guard. */
  function startDirect() {
    void guarded(() => beginMeeting());
  }

  /** End = the meeting's natural finish: save the recording, then the study
   *  pipeline runs the debrief. (The old single stop button, renamed.) */
  async function end() {
    await guarded(async () => {
      log.info("meeting: stop requested");
      stopMeeting();
      if (useRealPipeline) {
        // The real save runs async off the `recording-saved` event and takes
        // seconds (encode → persist → re-diarize → org share → load report).
        // Flag "finalizing" now so the button shows a spinner for that whole
        // window instead of reading as hung. Cleared when the save finishes or
        // Rust reports the recording was discarded (see listenForRecordingSaved).
        setFinalizingMeeting(true);
        try {
          await invoke("stop_meeting");
        } catch (e) {
          log.error("meeting: stop failed", { error: String(e) });
          setFinalizingMeeting(false);
        }
      } else {
        stopMockStream();
      }
    });
  }

  /** Pause/resume flips the store first (instant UI) then tells the backend to
   *  drop/readmit audio. The backend flag is idempotent, so no busy guard. */
  function togglePause() {
    if (paused) {
      log.info("meeting: resume requested");
      resumeMeeting();
    } else {
      log.info("meeting: pause requested");
      pauseMeeting();
    }
    if (useRealPipeline) {
      invoke("set_meeting_paused", { paused: !paused }).catch((e) =>
        log.error("meeting: pause toggle failed", { error: String(e) })
      );
    }
  }

  /** Cancel (from the confirm dialog): discard everything, back to idle. */
  async function cancel() {
    setConfirmCancel(false);
    await guarded(async () => {
      log.info("meeting: cancel requested");
      cancelMeeting();
      if (useRealPipeline) {
        try {
          await invoke("cancel_meeting");
        } catch (e) {
          log.error("meeting: cancel failed", { error: String(e) });
        }
      } else {
        stopMockStream();
      }
    });
  }

  async function controlWindow(action: WindowAction) {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    try {
      if (action === "close") await appWindow.close();
      if (action === "minimize") await appWindow.minimize();
      // Native macOS maps the green button to full screen (not window zoom).
      if (action === "fullscreen") await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    } catch (e) {
      log.warn("window: action failed", { action, error: String(e) });
    }
  }

  return (
    <header
      data-tauri-drag-region
      className={`relative flex h-[52px] shrink-0 items-center justify-between border-b bg-background/85 pr-3 backdrop-blur ${
        fullscreen ? "pl-4" : "pl-[104px]"
      }`}
    >
      {/* macOS traffic lights: native sizing/colours, glyphs reveal on hover of
          the whole cluster (not per-button), and the trio dims to grey when the
          window loses focus — matching the system buttons. Hidden in fullscreen,
          where macOS shows no window controls. */}
      {!fullscreen && <TrafficLights focused={focused} onAction={controlWindow} t={t} />}

      {/* Top-left: information, not brand (macOS's menu bar already says
          Parley). Pre-flight → which screen you're on; recording → the session
          vitals (rec + elapsed + mic level + translation). Where the meeting
          saves is decided in pre-flight now, next to the company that decides
          it — a titlebar folder chip here was the second, silently-losing
          source of truth for that. */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {/* Tense badge (R6): the ONE fixed "which tense am I in" signal —
            green while a live meeting runs, purple while a recording is open.
            The center slot is pure page tabs, so this carries the identity. */}
        {meetingActive && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
            LIVE
          </span>
        )}
        {studyMode && (
          <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-violet-600 dark:text-violet-400">
            {t("tense.study")}
          </span>
        )}
        {studyMode && <ReplayTitle t={t} />}
        {studyMode && <ReplayFolderChip />}
        {/* A loaded recording stays reachable while you look at something else.
            Navigating the tree away from it used to leave nothing on screen
            pointing back — the only route out was 離開, which discards it. */}
        {!studyMode && !meetingActive && replayName && (
          <button
            type="button"
            onClick={showReplay}
            title={replayName}
            className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FileAudio className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate">{replayName}</span>
          </button>
        )}
        {preflightMode && (
          <span className="text-xs font-medium text-muted-foreground">
            {t("preflight.title")}
          </span>
        )}
        {meetingActive && (
          <>
            <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
              {paused ? (
                <Circle className="h-2 w-2 fill-amber-500 text-amber-500" />
              ) : (
                <Circle className="h-2 w-2 animate-pulse fill-red-500 text-red-500" />
              )}
              {elapsed}
            </span>
            {paused ? (
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {t("titlebar.paused")}
              </span>
            ) : (
              <LevelMeter source="me" className="h-1.5 w-14" />
            )}
            {translateEnabled && (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Languages className="size-3.5" />
                {translateLanguage.toUpperCase()}
              </span>
            )}
          </>
        )}
      </div>

      {/* Titlebar-center switcher — two tenses, one slot: live shows the
          posture switch (coach/transcript); a loaded recording swaps in the
          study tabs (report/replay, purple accent) plus the analysis-status
          chip (the ONE generation surface for the whole study tense). */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          <CenterSwitcher
            mode={appMode}
            studyTab={studyTab}
            layout={layout}
            onStudyTab={setStudyTab}
            onLayout={(v) => updateSettings({ layout: v })}
            t={t}
          />
        </div>
        {studyMode && <StudyGenerationChip />}
      </div>

      <div className="flex items-center gap-2">
        {studyMode && <PostMeetingReviewButton />}
        <PrimaryAction
          mode={appMode}
          meetingActive={meetingActive}
          paused={paused}
          finalizing={isFinalizingMeeting}
          busy={toggleBusy}
          hasPrepDraft={hasPrepDraft}
          onExitReplay={() => {
            exitReplay();
            setStudyTab("report");
          }}
          onExitPreflight={exitPreflight}
          onTogglePause={togglePause}
          onEnd={() => void end()}
          onRequestCancel={() => setConfirmCancel(true)}
          onStart={start}
          onStartDirect={startDirect}
          onResetPrep={resetPrep}
          t={t}
        />
        {confirmCancel && (
          <CancelMeetingDialog
            t={t}
            onKeep={() => setConfirmCancel(false)}
            onConfirm={() => void cancel()}
          />
        )}

        {/* Customer intel, reachable in EVERY state (R5: no more scenario
            gating — an entry that vanishes because of a picker three screens
            away is a bug, not a feature; the accounts screen carries its own
            empty-state guidance). Mid-call it opens as a SHEET over the live
            screen — the full workspace is a mode switch and refuses to run
            while the call owns the screen. */}
        {!accountsMode && !preflightMode && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("accounts.title")}
            title={t("accounts.title")}
            onClick={() => (meetingActive ? setAccountsSheet(true) : openAccounts())}
          >
            <Building2 className="size-4" />
          </Button>
        )}
        {accountsSheet && (
          <Suspense fallback={null}>
            <AccountsSheet open onOpenChange={setAccountsSheet} />
          </Suspense>
        )}
        <McpStatusChip />
        {/* ONE 🌐 entry (R4): the popover fronts the meeting-translate switch,
            language, HUD pop-out, the standalone window and the settings link. */}
        <TranslateMenu />

        {/* History is a ROUTE in this window (#195). While a meeting runs the
            screen belongs to the call, so it is HONESTLY disabled (R2) —
            greyed with a reason — instead of looking clickable and silently
            doing nothing. The wrapping span exists because a disabled button
            has pointer-events:none — the reason-tooltip must live on a
            hoverable parent or it never shows. */}
        <span title={meetingActive ? t("titlebar.lockedWhileMeeting") : t("titlebar.history")}>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("titlebar.history")}
            disabled={meetingActive}
            onClick={() => openLibrary({ kind: "personal", folderId: null })}
          >
            <History className="size-4" />
          </Button>
        </span>

        {/* Settings is its own OS window, so unlike History it never takes the
            screen from a live call — no meeting lock. This gear is the ONE
            settings entry in the app (the sidebar deliberately has none). */}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={t("common.settings")}
          title={t("common.settings")}
          // Arrow, not a bare reference: openSettings takes an optional
          // category, and a passed-through MouseEvent would land in it.
          onClick={() => openSettings()}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
};
