import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Languages, Pause, Play, X } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { TRANSLATE_LANGUAGES, TRANSLATE_USD_PER_MINUTE } from "../lib/translateLanguages";
import { useI18n } from "../i18n";
import { Flag } from "../components/ui/flag";
import { LevelMeter } from "../components/LevelMeter";

/**
 * The floating interpreter window — the interpreter strip "popped out" as a
 * compact always-on-top HUD, so translation confidence stays visible while
 * Google Meet is fullscreen and Parley's main window is buried.
 *
 * It has no store coupling to the meeting (each webview has its own store):
 * everything it shows arrives over global Tauri events, and it closes itself
 * when the meeting stops.
 */
export function InterpreterApp() {
  const { t } = useI18n();
  // Settings sync via the persisted store is enough for the language label.
  const language = useStore((s) => s.settings.translateTargetLanguage);
  const languageFlag = TRANSLATE_LANGUAGES.find((l) => l.code === language)?.flag;

  const [live, setLive] = useState<{ input: string; output: string }>({ input: "", output: "" });
  const [paused, setPaused] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAt = useRef(Date.now());

  // Cost/elapsed ticker (from window open — close enough for a HUD).
  useEffect(() => {
    const id = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, []);

  // Live line + pause sync + self-close when the meeting ends.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => (mounted ? unlisteners.push(fn) : fn())).catch(() => {});
    track(
      listen<{ input: string; output: string }>("translate://transcript", (e) =>
        setLive(e.payload)
      )
    );
    track(listen<boolean>("translate://paused", (e) => setPaused(e.payload)));
    track(
      listen<string>("meeting://status", (e) => {
        if (e.payload === "stopped") void getCurrentWindow().close();
      })
    );
    return () => {
      mounted = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const togglePause = useCallback(() => {
    // State comes back via the translate://paused broadcast.
    invoke("set_translate_paused", { paused: !paused }).catch(() => {});
  }, [paused]);

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  const cost = ((elapsedSec / 60) * TRANSLATE_USD_PER_MINUTE).toFixed(3);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Drag handle / header */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
      >
        <span
          className={`flex items-center gap-1 font-semibold ${
            paused ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {languageFlag ? (
            <Flag code={languageFlag} className="size-3.5" />
          ) : (
            <Languages className="size-3.5" />
          )}{" "}
          {language.toUpperCase()}
        </span>
        <LevelMeter source="translate-out" className="h-1.5 w-10" />
        <span className="flex-1" data-tauri-drag-region />
        <span className="tabular-nums text-muted-foreground">
          {mm}:{ss} · ${cost}
        </span>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => void getCurrentWindow().close()}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Live bilingual line */}
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-4 py-2">
        {paused ? (
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            {t("translate.strip.pausedHint")}
          </p>
        ) : (
          <>
            <p className="truncate text-sm text-muted-foreground">
              {live.input || t("translate.strip.idle")}
            </p>
            <p className="truncate text-base font-medium text-emerald-600 dark:text-emerald-400">
              {live.output ? `→ ${live.output}` : "…"}
            </p>
          </>
        )}
      </div>

      {/* Pause */}
      <div className="flex shrink-0 justify-end border-t px-3 py-1.5">
        <button
          type="button"
          onClick={togglePause}
          className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${
            paused
              ? "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
              : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? t("translate.strip.resume") : t("translate.strip.pause")}
        </button>
      </div>
    </div>
  );
}
