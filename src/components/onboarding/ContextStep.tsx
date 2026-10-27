import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { removeEntry } from "../../lib/dictionary";
import {
  appendBackground,
  backgroundLines,
  memoryFilesToText,
  removeBackgroundLine,
  summarizeMemory,
} from "../../lib/onboarding/memoryImport";
import { addTerms, type AddedTerm } from "../../lib/onboarding/micCheck";
import * as ipc from "../../lib/ipc/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type MemoryState = "reading" | "ready" | "none" | "needLlm" | "unavailable" | { error: string };

/**
 * What every meeting prompt should know about the user:
 * - the speaker background (settings.userBackground, one fact per line),
 *   seeded by the self-introduction in the mic check, editable here;
 * - the terms transcription should spell right (the shared dictionary): the
 *   ones onboarding added, removable, plus any the user types;
 * - what their AI assistant remembers (settings.aiMemoryNotes): Claude Code's
 *   memory files, read and condensed when the step opens, shown read-only so
 *   the user can see what was taken.
 */
export function ContextStep({
  terms,
  setTerms,
}: Readonly<{ terms: AddedTerm[]; setTerms: (update: (prev: AddedTerm[]) => AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const lines = backgroundLines(settings.userBackground);
  const [newLine, setNewLine] = useState("");
  const [newTerm, setNewTerm] = useState("");

  function addLine() {
    const v = newLine.trim();
    if (!v) return;
    patch({ userBackground: appendBackground(settings.userBackground, [v]).text });
    setNewLine("");
  }

  function addTypedTerm() {
    const v = newTerm.trim();
    if (!v) return;
    setNewTerm("");
    addTerms([v])
      .then((added) => setTerms((prev) => [...prev, ...added]))
      .catch((e) => log.warn("onboarding: add term failed", { error: String(e) }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-semibold tracking-tight">{t("onboarding.context.title")}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.context.body")}</p>
      </div>

      {/* Speaker background */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t("onboarding.context.background")}</span>
        <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
          {lines.length === 0 && (
            <p className="py-1 text-[13px] text-muted-foreground">{t("onboarding.context.empty")}</p>
          )}
          {lines.map((line, i) => (
            // The same line can appear twice in hand-written text.
            <div key={`${i}:${line}`} className="flex items-start gap-2 py-0.5 text-[13px] leading-relaxed">
              <span className="text-muted-foreground">•</span>
              <span className="flex-1">{line}</span>
              <button
                type="button"
                aria-label={t("onboarding.context.removeLine")}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => patch({ userBackground: removeBackgroundLine(settings.userBackground, i) })}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <form
            className="flex gap-1.5 border-t border-dashed pt-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              addLine();
            }}
          >
            <Input
              value={newLine}
              onChange={(e) => setNewLine(e.target.value)}
              aria-label={t("onboarding.context.addLine")}
              placeholder={t("onboarding.context.addLine")}
              className="h-7 border-0 px-0.5 text-[13px] shadow-none focus-visible:ring-0"
            />
            <Button type="submit" variant="ghost" size="sm" className="h-7 text-xs text-primary" disabled={!newLine.trim()}>
              {t("onboarding.context.add")}
            </Button>
          </form>
        </div>
        {lines.length > 0 && (
          <span className="text-[11px] text-muted-foreground">{t("onboarding.context.backgroundHint")}</span>
        )}
      </div>

      {/* Dictionary terms */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t("onboarding.context.terms")}</span>
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addTypedTerm();
          }}
        >
          {terms.map((term) => (
            <span key={term.id} className="inline-flex h-6 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs">
              {term.phrase}
              <button
                type="button"
                aria-label={t("onboarding.context.removeTerm", { term: term.phrase })}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  removeEntry(term.id);
                  setTerms((prev) => prev.filter((x) => x.id !== term.id));
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <Input
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            aria-label={t("onboarding.context.terms")}
            placeholder={t("onboarding.context.termPlaceholder")}
            className="h-6 w-28 rounded-full border-dashed px-2.5 text-xs"
          />
          <Button type="submit" variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary" disabled={!newTerm.trim()}>
            {t("onboarding.context.add")}
          </Button>
        </form>
      </div>

      <AiMemory />
    </div>
  );
}

/**
 * Claude Code's memory, condensed. Read once when the step opens (unless an
 * earlier visit already kept a summary), shown read-only. Nothing to show and
 * nothing to do when there is no memory or no AI provider to condense it.
 */
function AiMemory() {
  const { t } = useI18n();
  const notes = useStore((s) => s.settings.aiMemoryNotes);
  const patch = useStore((s) => s.updateSettings);
  const [state, setState] = useState<MemoryState>(() => {
    if (notes.trim()) return "ready";
    if (!isTauri()) return "unavailable";
    return isProviderReady(useStore.getState().settings, "realtime") ? "reading" : "needLlm";
  });

  useEffect(() => {
    if (state !== "reading") return;
    let alive = true;
    (async () => {
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "none" as const;
      const lines = await summarizeMemory({ settings: useStore.getState().settings, text: memoryFilesToText(files) });
      if (lines.length === 0) return "none" as const;
      if (alive) patch({ aiMemoryNotes: lines.join("\n") });
      return "ready" as const;
    })()
      .then((next) => alive && setState(next))
      .catch((e) => {
        log.warn("onboarding: reading AI memory failed", { error: String(e) });
        if (alive) setState({ error: describeAiError(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "unavailable") return null;
  const lines = backgroundLines(notes);

  return (
    <div className="flex flex-col gap-1.5 border-t pt-4">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3 text-primary" />
        {t("onboarding.context.memory.title")}
      </span>
      {state === "reading" && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("onboarding.context.memory.reading")}
        </p>
      )}
      {state === "ready" && (
        <>
          <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-relaxed">
            {lines.map((line, i) => (
              <li key={`${i}:${line}`} className="flex gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="flex-1">{line}</span>
              </li>
            ))}
          </ul>
          <span className="text-[11px] text-muted-foreground">{t("onboarding.context.memory.source")}</span>
        </>
      )}
      {state === "none" && <p className="text-[13px] text-muted-foreground">{t("onboarding.context.memory.none")}</p>}
      {state === "needLlm" && (
        <p className="text-[13px] text-muted-foreground">{t("onboarding.context.memory.needLlm")}</p>
      )}
      {typeof state === "object" && (
        <p className="text-[13px] text-muted-foreground">{t("onboarding.context.memory.failed", { error: state.error })}</p>
      )}
    </div>
  );
}
