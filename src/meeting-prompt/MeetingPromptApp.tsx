import { useEffect, useRef, useState } from "react";
import { BellOff, ChevronDown, X } from "lucide-react";
import { useThemePreference } from "../lib/theme";
import { listenForSettings } from "../lib/settingsSync";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import { PILL_SIZE, PROMPT_MARGIN, PROMPT_MENU_EXTRA, PROMPT_SIZE, PROMPT_TIMEOUT_MS } from "../lib/meeting/detect";
import {
  initMeetingPromptClient,
  sendPromptAction,
  setPromptWindowHeight,
  type PromptState,
} from "../lib/meeting/detectPrompt";

/**
 * The prompt's countdown: dismisses after PROMPT_TIMEOUT_MS untouched, paused
 * while `paused`. Returns the share of the time left (1 → 0), for the line
 * along the pill's bottom edge.
 */
function useCountdown(key: string | null, paused: boolean, onDone: () => void): number {
  const [left, setLeft] = useState(1);
  const remaining = useRef(PROMPT_TIMEOUT_MS);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    remaining.current = PROMPT_TIMEOUT_MS;
    setLeft(1);
  }, [key]);

  useEffect(() => {
    if (key == null || paused) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      remaining.current = Math.max(0, remaining.current - (now - last));
      last = now;
      setLeft(remaining.current / PROMPT_TIMEOUT_MS);
      if (remaining.current <= 0) done.current();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [key, paused]);

  return left;
}

/**
 * The call prompt (its own small, unfocused window over the call, opened by
 * the main window's initMeetingDetect): one pill asking whether to record the
 * call another app just started. The answer goes back to the main window,
 * which records and closes this window.
 */
export function MeetingPromptApp() {
  useThemePreference();
  const { t } = useI18n();
  const [state, setState] = useState<PromptState | null>(null);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const unClient = initMeetingPromptClient(setState);
    const unSettings = listenForSettings();
    return () => {
      unClient();
      void unSettings.then((fn) => fn()).catch((error) =>
        log.warn("meeting-prompt: settings unlisten failed", { error: String(error) }),
      );
    };
  }, []);

  // The window grows under the pill only while the menu needs the room.
  useEffect(() => {
    void setPromptWindowHeight(PROMPT_SIZE.height + (menuOpen ? PROMPT_MENU_EXTRA : 0));
  }, [menuOpen]);

  const left = useCountdown(state ? `${state.app.appId}:${state.draft?.id ?? ""}` : null, hovered || menuOpen, () =>
    sendPromptAction("dismiss"),
  );

  // Esc closes the menu first, then the prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (menuOpen) setMenuOpen(false);
      else sendPromptAction("dismiss");
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!state) return null;
  const { app, draft } = state;
  const who =
    app.kind === "browser"
      ? t("detect.who.browser")
      : app.kind === "unknown"
        ? t("detect.who.unknown")
        : t("detect.who.app", { app: app.appName });
  const draftTitle = draft ? draft.title.trim() || t("floating.untitled") : null;
  const startLabel = draftTitle ? t("detect.startDraft", { title: draftTitle }) : t("detect.start");
  const canMute = app.kind !== "unknown" && app.appId !== "";

  return (
    <div className="h-screen w-screen" style={{ padding: PROMPT_MARGIN }}>
      {/* The pill clips its countdown line, so the close button sits on an
          unclipped wrapper, over the pill's top-left corner as in Notion's
          prompt; it shows while the pointer is on the prompt (or it's focused). */}
      <div
        className="group relative"
        style={{ width: PILL_SIZE.width, height: PILL_SIZE.height }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
      <button
        type="button"
        aria-label={t("detect.close")}
        title={t("detect.close")}
        onClick={() => sendPromptAction("dismiss")}
        className="absolute -top-2 -left-2 z-10 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
      <div
        role="alertdialog"
        aria-label={t("detect.title")}
        className="relative flex items-center gap-3 overflow-hidden rounded-full border border-border bg-background pr-3 pl-4 text-foreground shadow-[0_6px_20px_rgba(15,23,42,0.14),0_1px_3px_rgba(15,23,42,0.08)]"
        style={{ width: PILL_SIZE.width, height: PILL_SIZE.height }}
      >
        <img src="/parley.svg" alt="" className="size-8 shrink-0 rounded-[7px]" draggable={false} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] leading-5 font-semibold">{t("detect.title")}</span>
          <span className="truncate text-[13px] leading-[18px] text-muted-foreground" title={who}>
            {t("detect.subline", { who })}
          </span>
        </div>
        <div className="flex h-9 shrink-0 items-stretch overflow-hidden rounded-full bg-primary text-primary-foreground">
          <button
            type="button"
            onClick={() => sendPromptAction("start")}
            title={startLabel}
            className="max-w-[180px] truncate pr-2.5 pl-3.5 text-[13px] font-medium hover:bg-white/10"
          >
            {startLabel}
          </button>
          <span aria-hidden className="my-2 w-px bg-white/35" />
          <button
            type="button"
            aria-label={t("detect.more")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="grid w-8 place-items-center pr-0.5 hover:bg-white/10"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        {/* How long until it goes away by itself. */}
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-[2px] bg-primary/50"
          style={{ width: `${left * 100}%` }}
        />
      </div>
      </div>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 cursor-default"
            onClick={() => setMenuOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-[24px] flex min-w-[200px] max-w-[300px] flex-col rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ top: PROMPT_MARGIN + PILL_SIZE.height + 6 }}
            onMouseEnter={() => setHovered(true)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => sendPromptAction("dismiss")}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
            >
              <X className="size-3.5 shrink-0 text-muted-foreground" />
              {t("detect.notNow")}
            </button>
            {canMute && (
              <button
                type="button"
                role="menuitem"
                onClick={() => sendPromptAction("mute")}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
              >
                <BellOff className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t("detect.mute", { app: app.appName })}</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
