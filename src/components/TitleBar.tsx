import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  FileAudio,
  Folder as FolderIcon,
  FolderClosed,
  History,
  Loader2,
  Mic,
  Minus,
  Pause,
  Pencil,
  Play,
  Settings,
  Square,
  UsersRound,
  X,
} from "lucide-react";
import { useStore, meetingElapsedMs, type AppMode } from "../lib/store";
import { listLocalFolders, listenForFoldersUpdated, type Folder } from "../lib/history/folders";
import { breadcrumbParents, type CrumbIcon, type ParentCrumb } from "../lib/library/breadcrumb";
import { leaveRecordingTo } from "../lib/nav/navigate";
import { CLOUD_ENABLED } from "../lib/flags";
import type { Settings as AppSettings } from "../lib/types";
import { log } from "../lib/log";
import { sttApiKey } from "../lib/transcription/providers";
import { toast } from "sonner";
import { stopMockStream } from "../lib/mockStream";
import { isMac } from "../lib/platform";
import { isTauri } from "../lib/tauriEvents";
import { beginMeeting } from "../lib/meeting/start";
import { useCommandShortcut } from "../lib/commands/bind";
import { openSettings } from "../lib/nav/settings";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LevelMeter } from "./LevelMeter";
import { McpStatusChip } from "./McpStatusChip";
import { StudyGenerationChip } from "./study/StudyGenerationChip";


type TFn = ReturnType<typeof useI18n>["t"];
type WindowAction = "close" | "minimize" | "fullscreen" | "maximize";
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

/**
 * Track whether the main window is maximized, so the Windows caption cluster
 * can offer restore instead of a second maximize.
 *
 * Driven by the window's own resize event rather than by our click handler:
 * Windows Snap, a double-click on the drag region and the system menu all
 * maximize without ever passing through the button, and a button that lied
 * about the window state would be worse than the one that never changed. Tauri
 * has no dedicated maximize event, so onResized is the signal and isMaximized()
 * is the question — the payload only carries the new size.
 *
 * macOS never renders this cluster (the traffic lights do zoom instead), so
 * there's no listener to keep alive there.
 */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri() || isMac()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    async function connectResizeEvents() {
      const win = getCurrentWindow();
      const read = async () => {
        try {
          const now = await win.isMaximized();
          if (active) setMaximized(now);
        } catch {
          /* ignore — keep the last known state */
        }
      };
      // Seed from the current value: the window can already be maximized when
      // this mounts (a reload, or a size restored from the last session).
      await read();
      const un = await win.onResized(() => void read());
      if (active) unlisten = un;
      else un();
    }
    connectResizeEvents().catch((error) =>
      log.warn("window: maximize listener failed", { error: String(error) })
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return maximized;
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
 * The personal folder registry, kept live while the breadcrumb is on screen: a
 * rename in the sidebar (this window) or in another window broadcasts the
 * folders-updated event, and a cloud mirror-down lands on window focus.
 */
function usePersonalFolders(): Folder[] {
  const [folders, setFolders] = useState<Folder[]>(() => listLocalFolders());
  useEffect(() => {
    const refresh = () => setFolders(listLocalFolders());
    const un = listenForFoldersUpdated(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);
  return folders;
}

/** One org's folders, fetched only when a crumb needs one of their names. The
 *  cloud module is imported dynamically so the OSS bundle never reaches it. */
function useOrgFolders(orgId: string | null): { id: string; name: string }[] | null {
  const [state, setState] = useState<{ orgId: string; folders: { id: string; name: string }[] } | null>(
    null
  );
  useEffect(() => {
    if (!orgId || !CLOUD_ENABLED) return;
    let active = true;
    import("../lib/cloud/folders")
      .then((m) => m.listOrgFolders(orgId))
      .then((folders) => {
        if (active) setState({ orgId, folders });
      })
      .catch((e) => log.warn("titlebar: org folders failed", { orgId, error: String(e) }));
    return () => {
      active = false;
    };
  }, [orgId]);
  return state?.orgId === orgId ? state.folders : null;
}

/** The same icon the sidebar row for that node wears. */
function CrumbGlyph({ icon }: Readonly<{ icon: CrumbIcon }>) {
  const cls = "size-3.5 shrink-0";
  switch (icon) {
    case "folder":
      return <FolderIcon className={cls} />;
    case "unassigned":
      return <FolderClosed className={cls} />;
    case "all":
      return <AudioLines className={cls} />;
    case "org":
      return <UsersRound className={cls} />;
  }
}

function crumbLabel(crumb: ParentCrumb, t: TFn): string {
  if (crumb.name !== null) return crumb.name;
  return crumb.icon === "unassigned" ? t("library.unassigned") : t("library.all");
}

/**
 * Where the open recording lives, then its name: `和運租車 › 第二次報價`. The
 * parent crumb IS the way out — it closes the recording and opens that node of
 * the tree (through the nav stack, so ⌘[ comes back). It replaced a loud
 * 關閉這場錄音 button at the other end of the titlebar.
 */
function RecordingBreadcrumb({ t }: Readonly<{ t: TFn }>) {
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const replayReadOnly = useStore((s) => s.replayReadOnly);
  const replayFolderId = useStore((s) => s.replayFolderId);
  const librarySelection = useStore((s) => s.librarySelection);
  const personalFolders = usePersonalFolders();
  const orgFolders = useOrgFolders(
    replayReadOnly && librarySelection.kind === "org" && librarySelection.folderId
      ? librarySelection.id
      : null
  );
  const parents = breadcrumbParents({
    loadedHistoryId,
    replayReadOnly,
    replayFolderId,
    librarySelection,
    personalFolders,
    orgFolders,
  });

  return (
    <nav aria-label={t("replay.breadcrumb")} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-xs">
        {parents.map((crumb) => {
          const label = crumbLabel(crumb, t);
          return (
            <li key={`${crumb.icon}:${label}`} className="flex min-w-0 shrink items-center gap-0.5">
              <button
                type="button"
                title={t("replay.breadcrumb.open", { name: label })}
                onClick={() => void leaveRecordingTo(crumb.selection)}
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <CrumbGlyph icon={crumb.icon} />
                <span className="max-w-28 truncate">{label}</span>
              </button>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
            </li>
          );
        })}
        <li aria-current="page" className="flex min-w-0 items-center pl-1">
          <RecordingName t={t} />
        </li>
      </ol>
    </nav>
  );
}

/**
 * The breadcrumb's last crumb: the loaded recording's name, doubling as an
 * inline rename affordance (hover → pencil → input; Enter/blur commits, Escape
 * cancels — the same interaction as the History card). Rename persists to disk
 * + cloud + the History window via renameHistoryEntry, then updates the header
 * immediately via renameReplay. Only offered for recordings saved in the local
 * library; an unsaved upload or a read-only org recording (loadedHistoryId
 * null) renders the name read-only.
 */
function RecordingName({ t }: Readonly<{ t: TFn }>) {
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
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
        <FileAudio className="size-3.5 shrink-0 text-muted-foreground" />
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
    <span className="group/rename flex min-w-0 items-center gap-1.5 text-xs text-foreground">
      <FileAudio className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-48 truncate" title={replayName}>
        {replayName}
      </span>
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

/** One segment in the center switcher — a native-looking segmented control:
 *  the selected segment is a raised plain surface, never a colour fill. */
function SwitchTab({
  active,
  label,
  onClick,
}: Readonly<{ active: boolean; label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
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
      <SwitchTrack>
        {(["report", "replay"] as const).map((tab) => (
          <SwitchTab
            key={tab}
            active={studyTab === tab}
            label={t(`study.${tab}`)}
            onClick={() => onStudyTab(tab)}
          />
        ))}
      </SwitchTrack>
    );
  }
  if (mode === "live") {
    return (
      <SwitchTrack>
        {(["coach", "transcript"] as const).map((posture) => (
          <SwitchTab
            key={posture}
            active={layout === posture}
            label={t(`layout.${posture}`)}
            onClick={() => onLayout(posture)}
          />
        ))}
      </SwitchTrack>
    );
  }
  // Home and Library have no tabs, and an empty track still paints as a pill.
  return null;
}

/** The segmented control's muted track. Owned by CenterSwitcher so it only
 *  exists when there are tabs to put in it. */
function SwitchTrack({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">{children}</div>;
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
 * The trailing action for the current tense — exactly one of: drive the running
 * recorder, wait out the post-stop save, or start. Study has none: leaving a
 * recording is the breadcrumb's parent crumb at the leading edge.
 */
function PrimaryAction({
  mode,
  meetingActive,
  paused,
  finalizing,
  busy,
  hasPrepDraft,
  onTogglePause,
  onEnd,
  onRequestCancel,
  onStart,
  onResetPrep,
  t,
}: Readonly<{
  mode: AppMode;
  meetingActive: boolean;
  paused: boolean;
  finalizing: boolean;
  busy: boolean;
  hasPrepDraft: boolean;
  onTogglePause: () => void;
  onEnd: () => void;
  onRequestCancel: () => void;
  onStart: () => void;
  onResetPrep: () => void;
  t: TFn;
}>) {
  // Neither "study" nor "library" has an exit button. The library's tree is
  // always on screen, so leaving is picking somewhere else (#195); a recording
  // is left through its breadcrumb, whose parent crumb names where you land.
  if (mode === "study") return null;
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
  // One button: start. The chevron appears only when a prep draft from an
  // earlier call is still around, because clearing it is then the one other
  // thing you might want to do before recording.
  if (!hasPrepDraft) {
    return (
      <Button size="sm" variant="default" onClick={onStart} disabled={busy} className="h-8">
        <Mic className="size-3.5" />
        {t("titlebar.startMeeting")}
      </Button>
    );
  }
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
          <DropdownMenuItem onSelect={onResetPrep} className="text-muted-foreground">
            <Eraser className="size-3.5" />
            {t("titlebar.resetPrep")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Caption controls for the undecorated Windows main window: minimize /
 * maximize-or-restore / close at the trailing edge, full titlebar height, flat
 * hover — the native caption-button convention (close hovers Windows signal
 * red). The middle button follows the window's actual maximized state, so it
 * says restore once the window is maximized however that happened.
 */
function WindowsControls({
  maximized,
  onAction,
  t,
}: Readonly<{
  maximized: boolean;
  onAction: (action: WindowAction) => void;
  t: TFn;
}>) {
  const base = "grid w-11 place-items-center text-muted-foreground transition-colors";
  return (
    <div className="absolute right-0 top-0 flex h-full items-stretch">
      <button
        type="button"
        aria-label={t("titlebar.minimizeWindow")}
        onClick={() => onAction("minimize")}
        className={`${base} hover:bg-muted hover:text-foreground`}
      >
        <Minus className="size-4" strokeWidth={1.25} />
      </button>
      {/* One button, two states — the click is a toggle either way (see
          controlWindow), so the glyph and the label are all that change. The
          label matters as much as the glyph: a screen reader on a maximized
          window used to announce "maximize window". */}
      <button
        type="button"
        aria-label={maximized ? t("titlebar.restoreWindow") : t("titlebar.maximizeWindow")}
        onClick={() => onAction("maximize")}
        className={`${base} hover:bg-muted hover:text-foreground`}
      >
        {maximized ? (
          /* Windows' restore glyph: two offset squares, the back one up and to
             the right, with the overlap knocked out — so the back square is a
             path tracing only the edges the front square doesn't cover. */
          <svg viewBox="0 0 10 10" aria-hidden className="size-[10px]">
            <path
              d="M2.5 2.5V2A1.5 1.5 0 0 1 4 0.5H8A1.5 1.5 0 0 1 9.5 2V6A1.5 1.5 0 0 1 8 7.5H7.5"
              fill="none"
              stroke="currentColor"
            />
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden className="size-[10px]">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label={t("titlebar.closeWindow")}
        onClick={() => onAction("close")}
        className={`${base} hover:bg-[#C42B1C] hover:text-white`}
      >
        <X className="size-4" strokeWidth={1.25} />
      </button>
    </div>
  );
}

/**
 * Custom window titlebar. The main Tauri window is undecorated, so this header
 * owns both the draggable region and the window controls: macOS traffic lights
 * at the leading edge, Windows caption buttons at the trailing edge.
 *
 * In fullscreen there are no window controls (macOS hides the traffic lights and
 * reveals its own menu bar at the top edge), so we drop our controls and let
 * the logo + brand sit at the leading edge.
 */
export function TitleBar({ fullscreen = false }: Readonly<{ fullscreen?: boolean }>) {
  const { t } = useI18n();
  const focused = useWindowFocused();
  const maximized = useWindowMaximized();
  const status = useStore((s) => s.meetingStatus);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const stopMeeting = useStore((s) => s.stopMeeting);
  const isFinalizingMeeting = useStore((s) => s.isFinalizingMeeting);
  const setFinalizingMeeting = useStore((s) => s.setFinalizingMeeting);
  const pauseMeeting = useStore((s) => s.pauseMeeting);
  const resumeMeeting = useStore((s) => s.resumeMeeting);
  const cancelMeeting = useStore((s) => s.cancelMeeting);
  const layout = useStore((s) => s.settings.layout);
  const updateSettings = useStore((s) => s.updateSettings);
  const meetingStartedAt = useStore((s) => s.meetingStartedAt);
  const studyTab = useStore((s) => s.studyTab);
  const setStudyTab = useStore((s) => s.setStudyTab);
  const [elapsed, setElapsed] = useState("00:00");
  const appMode = useStore((s) => s.appMode);
  const openLibrary = useStore((s) => s.openLibrary);
  const showReplay = useStore((s) => s.showReplay);
  const replayName = useStore((s) => s.replay?.name ?? null);
  const resetPrep = useStore((s) => s.resetPrep);
  // A non-empty prep draft unlocks the explicit "clear prep" menu item.
  const hasPrepDraft = useStore(
    (s) =>
      !!s.meetingFolderId ||
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

  /** Start = record right now, riding whatever prep draft is already set. */
  function start() {
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
        // seconds (encode → persist → open the report). Flag "finalizing" now
        // so the button shows a spinner for that window instead of reading as
        // hung (it also keeps the shell's focused layout up until the report
        // replaces the cockpit). Cleared the moment the report opens — speaker
        // correction and the org share continue in the background — or when
        // the save fails or Rust reports the recording was discarded (see
        // saveLiveToHistory / listenForRecordingSaved).
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

  // The keyboard reaches exactly the two recorder actions that are safe to
  // reach blind. Both are gated with `enabled` rather than a bail-out inside
  // the handler, so a chord that doesn't apply right now is genuinely unbound —
  // it falls through to whoever else wants it instead of being swallowed by a
  // preventDefault and a silent return.
  //
  // Start mirrors the Start button's own liveness EXACTLY — including the study
  // screen, where PrimaryAction offers no Start at all. Reviewing an old
  // recording and hitting ⌘R would otherwise start a live meeting on top of it,
  // and the one thing a shortcut must never do is an action the screen isn't
  // offering. ⌘R is the most reflexively-pressed chord on the platform
  // ("reload"), so every state where the button is absent or disabled has to be
  // a genuine no-op rather than a second start racing the first.
  useCommandShortcut("meeting.start", start, {
    enabled: appMode !== "study" && !meetingActive && !isFinalizingMeeting && !toggleBusy,
  });
  // Deliberately no ⌘-anything for End. Ending is not undoable, and someone
  // reaching for a refresh must not be able to stop a recording — so it stays a
  // button you have to look at. Do not "complete the symmetry" here.
  useCommandShortcut("meeting.togglePause", togglePause, { enabled: meetingActive });

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
      // Windows caption button semantics: maximize/restore, not fullscreen.
      if (action === "maximize") await appWindow.toggleMaximize();
    } catch (e) {
      log.warn("window: action failed", { action, error: String(e) });
    }
  }

  // Reserve the leading gutter for macOS traffic lights and the trailing one
  // for Windows caption buttons; fullscreen shows no controls on either OS.
  const mac = isMac();
  const padLeft = !fullscreen && mac ? "pl-[104px]" : "pl-4";
  const padRight = !fullscreen && !mac ? "pr-[140px]" : "pr-3";

  return (
    <header
      data-tauri-drag-region
      className={`relative grid h-[52px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-3 border-b bg-background ${padLeft} ${padRight}`}
    >
      {/* macOS traffic lights: native sizing/colours, glyphs reveal on hover of
          the whole cluster (not per-button), and the trio dims to grey when the
          window loses focus — matching the system buttons. Hidden in fullscreen,
          where macOS shows no window controls. */}
      {!fullscreen && mac && <TrafficLights focused={focused} onAction={controlWindow} t={t} />}
      {!fullscreen && !mac && (
        <WindowsControls maximized={maximized} onAction={controlWindow} t={t} />
      )}

      {/* Top-left: information, not brand (macOS's menu bar already says
          Parley) — while recording, the session vitals (rec + elapsed + mic
          level). Where the meeting saves is decided by the folder picker, so a
          second folder chip here would be a silently-losing source of truth. */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {/* The recording pill (below) is the one badge worth a fixed slot: a
            recording in progress is state you must not miss. The study tense needs no counterpart — the
            page tabs in the center already say which tense you are in,
            and a "書房" chip in front of every meeting name only pushed the name
            it was labelling out of view. The breadcrumb's parent crumb names
            where the recording lives (還沒歸檔 included) because it is the way
            OUT, not a filing prompt — filing still has ONE home, the report
            page's link bar. */}
        {studyMode && <RecordingBreadcrumb t={t} />}
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
        {meetingActive && (
          <>
            {/* ONE recording pill: dot + elapsed. Red while recording; the
                warning family while paused, so a paused meeting doesn't read
                as a running one. */}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 ${
                paused ? "bg-warning text-warning-foreground" : "bg-recording/10 text-recording"
              }`}
            >
              <span
                aria-hidden
                className={`size-2 rounded-full ${
                  paused ? "bg-warning-foreground" : "animate-pulse bg-recording"
                }`}
              />
              <span className="font-display text-[13px] font-semibold tabular-nums">{elapsed}</span>
            </span>
            {paused ? (
              <span className="text-xs font-medium text-warning-foreground">
                {t("titlebar.paused")}
              </span>
            ) : (
              <LevelMeter source="me" className="h-1.5 w-14" />
            )}
          </>
        )}
      </div>

      {/* Titlebar-center switcher — two tenses, one slot: live shows the
          posture switch (coach/transcript); a loaded recording swaps in the
          study tabs (report/replay) plus the analysis-status
          chip (the ONE generation surface for the whole study tense).
          A grid column, not an absolutely-centred overlay: equal side tracks
          keep it centred, and a long breadcrumb truncates in its own track
          instead of sliding underneath the tabs. */}
      <div className="flex items-center gap-2">
        <CenterSwitcher
          mode={appMode}
          studyTab={studyTab}
          layout={layout}
          onStudyTab={setStudyTab}
          onLayout={(v) => updateSettings({ layout: v })}
          t={t}
        />
        {studyMode && <StudyGenerationChip />}
      </div>

      <div className="flex items-center gap-2 justify-self-end">
        <PrimaryAction
          mode={appMode}
          meetingActive={meetingActive}
          paused={paused}
          finalizing={isFinalizingMeeting}
          busy={toggleBusy}
          hasPrepDraft={hasPrepDraft}
          onTogglePause={togglePause}
          onEnd={() => void end()}
          onRequestCancel={() => setConfirmCancel(true)}
          onStart={start}
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

        <McpStatusChip />

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
            onClick={() => openLibrary({ kind: "personal", node: { kind: "unassigned" } })}
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
