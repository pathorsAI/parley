import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, Languages, Pause, Play } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { TRANSLATE_USD_PER_MINUTE } from "../lib/translateLanguages";
import { openInterpreterWindow } from "../lib/liveTranslate";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { LevelMeter } from "./LevelMeter";

/**
 * The interpreter strip: a slim bar under the live screen, shown only while a
 * TRANSLATED meeting is recording. One glanceable line of translation state —
 * what's being said → what the counterpart hears, the outgoing level, a live
 * cost ticker, and the pause switch (silence to the counterpart, no billing).
 */
export function TranslateStrip() {
  const { t } = useI18n();
  const status = useStore((s) => s.meetingStatus);
  const enabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const language = useStore((s) => s.settings.translateTargetLanguage);

  const [live, setLive] = useState<{ input: string; output: string }>({ input: "", output: "" });
  const [paused, setPaused] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAt = useRef<number | null>(null);

  const recording = status === "recording";
  const active = recording && enabled && isTauri();

  // Elapsed/cost ticker + per-meeting reset (pause state included: the backend
  // re-arms unpaused on every start).
  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsedSec(0);
      setPaused(false);
      setLive({ input: "", output: "" });
      return;
    }
    startedAt.current = Date.now();
    const id = setInterval(() => {
      if (startedAt.current) setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  // Live bilingual line + pause sync (the pause state is broadcast so the
  // floating interpreter window and this strip always agree).
  useEffect(() => {
    if (!active) return;
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
    return () => {
      mounted = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [active]);

  const togglePause = useCallback(() => {
    // State comes back via the translate://paused broadcast.
    invoke("set_translate_paused", { paused: !paused }).catch((e) => {
      log.warn("translate: pause toggle failed", { error: String(e) });
    });
  }, [paused]);

  if (!active) return null;

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  const cost = ((elapsedSec / 60) * TRANSLATE_USD_PER_MINUTE).toFixed(3);

  return (
    <div
      className={`flex shrink-0 items-center gap-3 border-t px-4 py-1.5 text-xs ${
        paused ? "bg-amber-500/10" : "bg-emerald-500/5"
      }`}
    >
      <span
        className={`flex items-center gap-1 font-semibold ${
          paused ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
        }`}
      >
        <Languages className="size-3.5" />
        {language.toUpperCase()}
      </span>

      {paused ? (
        <span className="flex-1 truncate font-medium text-amber-700 dark:text-amber-400">
          {t("translate.strip.pausedHint")}
        </span>
      ) : (
        <span className="flex-1 truncate text-muted-foreground">
          {live.input}
          {live.output && (
            <span className="italic text-emerald-600 dark:text-emerald-400"> → {live.output}</span>
          )}
          {!live.input && !live.output && t("translate.strip.idle")}
        </span>
      )}

      <LevelMeter source="translate-out" className="h-1.5 w-12" />
      <span className="tabular-nums text-muted-foreground">
        {mm}:{ss} · ${cost}
      </span>

      <button
        type="button"
        onClick={togglePause}
        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium transition-colors ${
          paused
            ? "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
            : "border-border text-muted-foreground hover:bg-muted"
        }`}
      >
        {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        {paused ? t("translate.strip.resume") : t("translate.strip.pause")}
      </button>

      <button
        type="button"
        onClick={() => void openInterpreterWindow()}
        title={t("translate.strip.popout")}
        aria-label={t("translate.strip.popout")}
        className="rounded-md border border-border p-1 text-muted-foreground hover:bg-muted"
      >
        <ExternalLink className="size-3" />
      </button>
    </div>
  );
}
