import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Building2, Check, Circle, FileAudio, History, Languages, LogOut, Mic, Minus, Pause, Pencil, Play, Settings, Square, X } from "lucide-react";
import { useStore, meetingElapsedMs } from "../lib/store";
import { log } from "../lib/log";
import { STT_BY_ID, sttApiKey, sttRelayUrl } from "../lib/transcription/providers";
import { toast } from "sonner";
import { startMockStream, stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { openSettingsWindow } from "../lib/settingsSync";
import { openHistoryWindow } from "../lib/history/history";
import { openLiveTranslateWindow } from "../lib/liveTranslate";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "./LevelMeter";
import { McpStatusChip } from "./McpStatusChip";
import { ReplayFolderChip } from "./ReplayFolderChip";
import { SaveDestinationPicker } from "./SaveDestinationPicker";
import { PostMeetingReviewButton } from "./accounts/PostMeetingReviewButton";
import { StudyGenerationChip } from "./study/StudyGenerationChip";

type TFn = ReturnType<typeof useI18n>["t"];
type WindowAction = "close" | "minimize" | "fullscreen";

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
  const transcriptionProvider = useStore((s) => s.settings.transcriptionProvider);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const startMeeting = useStore((s) => s.startMeeting);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const pauseMeeting = useStore((s) => s.pauseMeeting);
  const resumeMeeting = useStore((s) => s.resumeMeeting);
  const cancelMeeting = useStore((s) => s.cancelMeeting);
  const translateEnabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const translateLanguage = useStore((s) => s.settings.translateTargetLanguage);
  const translateOutputDevice = useStore((s) => s.settings.translateOutputDevice);
  const geminiApiKey = useStore((s) => s.settings.geminiApiKey);
  const layout = useStore((s) => s.settings.layout);
  const updateSettings = useStore((s) => s.updateSettings);
  const saveLocation = useStore((s) => s.settings.defaultSaveLocation);
  const syncEnabled = useStore((s) => s.settings.syncEnabled);
  const meetingStartedAt = useStore((s) => s.meetingStartedAt);
  const studyTab = useStore((s) => s.studyTab);
  const setStudyTab = useStore((s) => s.setStudyTab);
  const [elapsed, setElapsed] = useState("00:00");
  const appMode = useStore((s) => s.appMode);
  const exitReplay = useStore((s) => s.exitReplay);
  const enterAccounts = useStore((s) => s.enterAccounts);
  const exitAccounts = useStore((s) => s.exitAccounts);
  // The accounts area only exists for business meeting types (design D12).
  const meetingType = useStore((s) => s.settings.meetingType);
  const businessType = meetingType === "sales" || meetingType === "negotiation" || meetingType === "partnership";
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
  const replayMode = appMode === "replay";
  const accountsMode = appMode === "accounts";

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

  async function start() {
    await guarded(async () => {
      // Meeting translation needs its own (Gemini) key on top of the STT key;
      // refuse loudly rather than silently starting an untranslated meeting.
      if (useRealPipeline && translateEnabled && !geminiApiKey.trim()) {
        toast.error(t("meeting.translate.noKey"));
        return;
      }
      startMeeting();
      if (useRealPipeline) {
        log.info("meeting: start requested", {
          provider: transcriptionProvider,
          model: STT_BY_ID[transcriptionProvider].label,
          diarization: STT_BY_ID[transcriptionProvider].diarization,
          inputDevice,
          translate: translateEnabled ? translateLanguage : "off",
          pipeline: "real",
        });
        try {
          // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL
          // + the session token as apiKey, via sttApiKey). BYOK providers send no
          // relay URL and connect straight to their vendor.
          const relayUrl = sttRelayUrl(transcriptionProvider);
          await invoke("start_meeting", {
            provider: transcriptionProvider,
            apiKey: sttKey,
            diarization: STT_BY_ID[transcriptionProvider].diarization,
            inputDevice,
            relayUrl,
            // Meeting translation (off → nulls): "me" runs through Gemini
            // live-translate; the voice goes out the translate output device.
            translateLanguage: translateEnabled ? translateLanguage : null,
            translateOutputDevice: translateEnabled ? translateOutputDevice || null : null,
            translateApiKey: translateEnabled ? geminiApiKey : null,
          });
        } catch (e) {
          log.error("meeting: start failed", {
            provider: transcriptionProvider,
            inputDevice,
            error: String(e),
          });
          stopMeeting();
        }
      } else if (transcriptionProvider === "parley") {
        // Hosted STT selected but no usable cloud session — never fake it with a
        // mock transcript; tell the user to sign in and back out of "recording".
        log.info("meeting: start blocked (parley, no session)");
        stopMeeting();
        toast.error(t("meeting.error.signin"));
      } else {
        log.info("meeting: start (mock stream)");
        startMockStream();
      }
    });
  }

  /** End = the meeting's natural finish: save the recording, then the study
   *  pipeline runs the debrief. (The old single stop button, renamed.) */
  async function end() {
    await guarded(async () => {
      log.info("meeting: stop requested");
      stopMeeting();
      if (useRealPipeline) {
        try {
          await invoke("stop_meeting");
        } catch (e) {
          log.error("meeting: stop failed", { error: String(e) });
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
          Parley). Idle → where this meeting will save (org/folder menu, no
          Settings trip); recording → the session vitals (rec + elapsed + mic
          level + translation). */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {replayMode && <ReplayTitle t={t} />}
        {replayMode && <ReplayFolderChip />}
        {!replayMode && !meetingActive && (
          <SaveDestinationPicker
            compact
            value={saveLocation}
            syncOn={syncEnabled}
            onChange={(loc) => updateSettings({ defaultSaveLocation: loc })}
          />
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
        {accountsMode ? (
          <span className="px-3 py-1 text-xs font-medium text-muted-foreground">
            {t("accounts.title")}
          </span>
        ) : replayMode
          ? (["report", "replay"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStudyTab(tab)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  studyTab === tab
                    ? "bg-background text-violet-600 shadow-sm dark:text-violet-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`study.${tab}`)}
              </button>
            ))
          : (["coach", "transcript"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateSettings({ layout: mode })}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  layout === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`layout.${mode}`)}
              </button>
            ))}
        </div>
        {replayMode && <StudyGenerationChip />}
      </div>

      <div className="flex items-center gap-2">
        {replayMode && <PostMeetingReviewButton />}
        {replayMode ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              exitReplay();
              setStudyTab("report");
            }}
            className="h-8"
          >
            <LogOut className="size-3.5" />
            {t("replay.exit")}
          </Button>
        ) : accountsMode ? (
          <Button size="sm" variant="outline" onClick={exitAccounts} className="h-8">
            <LogOut className="size-3.5" />
            {t("accounts.exit")}
          </Button>
        ) : meetingActive ? (
          // Recorder cluster: pause/resume ⇄, end (save → debrief), cancel
          // (discard, confirm-gated). All three live in both states, so the
          // user always has 繼續/結束/取消 at hand — the ask in issue terms.
          <>
            <Button
              size="sm"
              variant={paused ? "default" : "outline"}
              onClick={togglePause}
              // Held while a start/end/cancel invoke is in flight: pausing
              // mid-start could land set_meeting_paused BEFORE start_meeting
              // resets the flag, splitting UI and backend pause state.
              disabled={toggleBusy}
              className="h-8"
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? t("titlebar.resume") : t("titlebar.pause")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={end}
              disabled={toggleBusy}
              className="h-8"
            >
              <Square className="size-3.5" />
              {t("titlebar.end")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label={t("titlebar.cancelMeeting")}
              title={t("titlebar.cancelMeeting")}
              disabled={toggleBusy}
              onClick={() => setConfirmCancel(true)}
            >
              <X className="size-4" />
            </Button>
          </>
        ) : (
          <Button size="sm" variant="default" onClick={start} disabled={toggleBusy} className="h-8">
            <Mic className="size-3.5" />
            {t("titlebar.startMeeting")}
          </Button>
        )}
        {confirmCancel && (
          <CancelMeetingDialog
            t={t}
            onKeep={() => setConfirmCancel(false)}
            onConfirm={() => void cancel()}
          />
        )}

        {businessType && !accountsMode && !meetingActive && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("accounts.title")}
            title={t("accounts.title")}
            onClick={enterAccounts}
          >
            <Building2 className="size-4" />
          </Button>
        )}
        <McpStatusChip />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={t("titlebar.liveTranslate")}
          title={t("titlebar.liveTranslate")}
          onClick={() => openLiveTranslateWindow().catch((error) => log.error("live-translate: open window failed", { error: String(error) }))}
        >
          <Languages className="size-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={t("titlebar.history")}
          title={t("titlebar.history")}
          onClick={() => openHistoryWindow().catch((error) => log.error("history: open window failed", { error: String(error) }))}
        >
          <History className="size-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => openSettingsWindow().catch((error) => log.error("settings: open window failed", { error: String(error) }))}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
};
