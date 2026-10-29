import { useEffect, useState } from "react";
import { BookOpen, Brain, Loader2, RotateCcw, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { addTerms } from "../../lib/onboarding/micCheck";
import {
  backgroundLines,
  refreshAiMemory,
  removeBackgroundLines,
  removeMemoryLine,
  type MemoryNotCondensed,
} from "../../lib/onboarding/memoryImport";
import type { AppLanguage } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TermsTab } from "./TermsTab";

type ContextTab = "terms" | "speaker";

/**
 * 語境庫: what every meeting is told about the user, in one place — the terms
 * transcription should spell right (the shared dictionary), the speaker
 * background they write themselves, and what their AI assistant remembers.
 * Onboarding's context step fills all three the first time; this is where
 * they are kept up afterwards.
 *
 * The open tab is plain component state: coming back to the page starts on
 * 常用詞, the one most visits are for.
 */
export function ContextLibraryScreen() {
  const { t } = useI18n();
  const [tab, setTab] = useState<ContextTab>("terms");

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <h1 className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight">
          <BookOpen className="size-4 text-muted-foreground" />
          {t("context.title")}
        </h1>
        <span className="text-xs text-muted-foreground">{t("context.subtitle")}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as ContextTab)}
          className="max-w-[672px] gap-4 px-6 py-5"
        >
          <TabsList aria-label={t("context.title")} className="self-start">
            <TabsTrigger value="terms" className="px-2.5">
              {t("context.tabs.terms")}
            </TabsTrigger>
            <TabsTrigger value="speaker" className="px-2.5">
              {t("context.tabs.speaker")}
            </TabsTrigger>
          </TabsList>
          {/* Both tabs stay mounted: switching away must not drop an unsaved
              background, or restart a memory read that is under way. */}
          <TabsContent value="terms" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
            <TermsTab />
          </TabsContent>
          <TabsContent value="speaker" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
            <SpeakerBackground />
            <AiMemory />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

/**
 * settings.userBackground, with an explicit save: this text goes into every
 * meeting prompt, so a half-typed sentence shouldn't. The draft follows the
 * saved value while it is untouched (an edit in Settings › 基本設定 shows up
 * here), and stops following once the user starts typing.
 */
function SpeakerBackground() {
  const { t } = useI18n();
  const saved = useStore((s) => s.settings.userBackground);
  const patch = useStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(saved);
  const [touched, setTouched] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!touched) setDraft(saved);
  }, [saved, touched]);

  const dirty = draft !== saved;
  let hint = "";
  if (dirty) hint = t("context.speaker.dirty");
  else if (justSaved) hint = t("context.speaker.saved");

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="context-background" className="text-xs text-muted-foreground">
        {t("context.speaker.label")}
      </label>
      <Textarea
        id="context-background"
        rows={6}
        value={draft}
        placeholder={t("onboarding.context.backgroundPlaceholder")}
        className="min-h-[9.5rem] resize-y rounded-[10px] text-sm leading-relaxed"
        onChange={(e) => {
          setDraft(e.target.value);
          setTouched(true);
          setJustSaved(false);
        }}
      />
      <div className="flex items-center gap-2.5">
        <Button
          size="sm"
          className="h-8 px-3"
          // Dimmed rather than greyed: nothing to save is a state, not an error.
          disabled={!dirty}
          onClick={() => {
            patch({ userBackground: draft });
            setTouched(false);
            setJustSaved(true);
          }}
        >
          {t("context.speaker.save")}
        </Button>
        <span className="text-[11px] text-muted-foreground" role="status" aria-live="polite">
          {hint}
        </span>
      </div>
    </div>
  );
}

/** "idle": nothing running, whatever notes are kept are shown. "none" / "empty":
 *  the last read found no memory files / nothing worth keeping in them. An
 *  object: found but not condensed, and why. */
type MemoryState =
  | "idle"
  | "reading"
  | "none"
  | "empty"
  | { why: MemoryNotCondensed; excerpt: boolean };

function updatedLabel(
  at: number,
  now: number,
  language: AppLanguage,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
): string {
  const locale = language === "en" ? "en" : "zh-TW";
  const when = new Date(at);
  const time = when.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (when.toDateString() === new Date(now).toDateString()) return t("context.memory.today", { time });
  const date = when.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  return `${date} ${time}`;
}

/**
 * What Claude Code's memory added to the speaker background
 * (settings.aiMemoryNotes), read-only apart from dropping a line (which drops
 * it from the background too). 重新讀取 runs onboarding's "how you work" again
 * (refreshAiMemory). It only ever runs when asked — or once on
 * opening when nothing is kept yet — because Parley doesn't watch the files.
 */
function AiMemory() {
  const { t, language } = useI18n();
  const notes = useStore((s) => s.settings.aiMemoryNotes);
  const updatedAt = useStore((s) => s.settings.aiMemoryUpdatedAt);
  const patch = useStore((s) => s.updateSettings);
  const desktop = isTauri();
  const [state, setState] = useState<MemoryState>(() =>
    desktop && !notes.trim() ? "reading" : "idle"
  );

  useEffect(() => {
    if (state !== "reading") return;
    let alive = true;
    refreshAiMemory({
      settings: () => useStore.getState().settings,
      patch,
      addTerms,
      alive: () => alive,
    })
      .then((outcome): MemoryState => {
        switch (outcome.kind) {
          case "none":
            return "none";
          case "condensed":
            return outcome.empty ? "empty" : "idle";
          case "notCondensed":
            return { why: outcome.why, excerpt: outcome.excerpt };
          default:
            return "idle";
        }
      })
      .then((next) => alive && setState(next))
      .catch((e) => {
        log.warn("context: reading AI memory failed", { error: String(e) });
        if (alive) setState({ why: { failed: String(e) }, excerpt: false });
      });
    return () => {
      alive = false;
    };
  }, [state, patch]);

  const lines = backgroundLines(notes);
  const reading = state === "reading";
  const notCondensed = typeof state === "object" ? state : null;
  let why = "";
  if (notCondensed?.why === "needLlm") why = t("onboarding.context.memory.needLlm");
  else if (notCondensed) why = t("onboarding.context.memory.failed", { error: notCondensed.why.failed });

  let emptyText = "";
  if (!desktop) emptyText = t("context.memory.desktopOnly");
  else if (state === "none") emptyText = t("context.memory.none");
  else if (state === "empty") emptyText = t("context.memory.nothing");
  else emptyText = t("context.memory.cleared");

  const reread = desktop && (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 text-muted-foreground"
      aria-label={t("context.memory.reread")}
      title={t("context.memory.reread")}
      disabled={reading}
      onClick={() => setState("reading")}
    >
      {reading ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
    </Button>
  );

  // Nothing kept and nothing in flight: one line saying why, and a way to try again.
  const showBox = lines.length > 0 || reading || !!notCondensed;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{t("context.memory.title")}</span>
      {showBox ? (
        <div className="flex flex-col gap-2 rounded-[10px] border p-3">
          <div className="flex items-center gap-2 text-xs">
            <Brain className="size-3.5 shrink-0 text-muted-foreground" />
            <span>{t("context.memory.source")}</span>
            {updatedAt > 0 && (
              <span className="text-muted-foreground">
                · {t("context.memory.updated", { time: updatedLabel(updatedAt, Date.now(), language, t) })}
              </span>
            )}
            <span className="flex-1" />
            {reread}
          </div>
          {notCondensed && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {why} {notCondensed.excerpt && t("onboarding.context.memory.excerpt")}
            </p>
          )}
          {reading && lines.length === 0 && (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("onboarding.context.memory.reading")}
            </p>
          )}
          {lines.length > 0 && (
            <ul className="flex flex-col">
              {lines.map((line, i) => (
                <li key={`${i}:${line}`} className="flex items-start gap-2 text-[13px] leading-relaxed">
                  <span className="text-muted-foreground">•</span>
                  <span className="min-w-0 flex-1">{line}</span>
                  <button
                    type="button"
                    aria-label={t("context.memory.removeLine")}
                    title={t("context.memory.removeLine")}
                    className="mt-0.5 grid size-5.5 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() =>
                      // The line lives in the background too: it goes from both.
                      patch({
                        aiMemoryNotes: removeMemoryLine(notes, i),
                        userBackground: removeBackgroundLines(useStore.getState().settings.userBackground, [line]),
                      })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="text-[11px] text-muted-foreground">{t("context.memory.footer")}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{emptyText}</span>
          {reread}
        </div>
      )}
    </div>
  );
}
