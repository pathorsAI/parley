import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { removeEntry } from "../../lib/dictionary";
import {
  backgroundLines,
  excerptMemory,
  memoryFilesToText,
  readingSteps,
  summarizeMemory,
  type ReadingStep,
} from "../../lib/onboarding/memoryImport";
import { prefersReducedMotion } from "../../lib/onboarding/motion";
import { cn } from "@/lib/utils";
import {
  addTerms,
  editedWord,
  findNameEdit,
  learnTerm,
  mergeTerms,
  termCandidate,
  type AddedTerm,
} from "../../lib/onboarding/micCheck";
import { detectCorrection } from "../../lib/dictionary/diffCorrection";
import {
  isIgnoredTwice,
  listEntries,
  profileTerms,
  recognitionTerms,
  recordIgnore,
  whenDictionaryReady,
} from "../../lib/dictionary";
import * as ipc from "../../lib/ipc/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * What every meeting prompt should know about the user:
 * - the speaker background (settings.userBackground), seeded by the
 *   self-introduction in the mic check, edited here as free text; editing a
 *   few words in it offers them to the dictionary;
 * - the terms transcription should spell right (the shared dictionary): the
 *   user's name and company, the company, people and product names from the
 *   self-introduction and the AI memory, and any the user types — removable;
 * - what their AI assistant remembers (settings.aiMemoryNotes): Claude Code's
 *   memory files, read and condensed when the step opens — a reading log
 *   plays while that happens — then shown read-only so the user can see what
 *   was taken.
 */
export function ContextStep({
  terms,
  setTerms,
}: Readonly<{ terms: AddedTerm[]; setTerms: (update: (prev: AddedTerm[]) => AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const [newTerm, setNewTerm] = useState("");

  // The user's own company and name are always terms (Settings, or filled
  // from the self-introduction), each spelling of them on its own — and they
  // follow the fields if those change while the step is open. No AI needed.
  const userName = useStore((s) => s.settings.userName);
  const userCompany = useStore((s) => s.settings.userCompany);
  useEffect(() => {
    addTerms(profileTerms({ userName, userCompany }))
      .then((found) => setTerms((prev) => mergeTerms(prev, found)))
      .catch((e) => log.warn("onboarding: adding profile terms failed", { error: String(e) }));
  }, [userName, userCompany, setTerms]);

  function addTypedTerm() {
    const v = newTerm.trim();
    if (!v) return;
    setNewTerm("");
    addTerms([v])
      .then((added) => setTerms((prev) => mergeTerms(prev, added)))
      .catch((e) => log.warn("onboarding: add term failed", { error: String(e) }));
  }

  return (
    // Fills the step, so the AI memory below can take whatever height is left.
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* Speaker background */}
      <BackgroundEditor
        terms={terms}
        onTermLearned={(term) => setTerms((prev) => mergeTerms(prev, [term]))}
      />

      {/* Dictionary terms */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-[#333] dark:text-foreground">{t("onboarding.context.terms")}</span>
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addTypedTerm();
          }}
        >
          {terms.map((term) => (
            <span
              key={term.id}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-[#e3e6ec] pr-1 pl-2.5 text-xs text-foreground dark:border-border"
            >
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
            className="h-6 w-28 rounded-full border-dashed border-[#dadee5] px-2.5 text-sm placeholder:text-muted-foreground dark:border-input"
          />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-primary disabled:opacity-50"
            disabled={!newTerm.trim()}
          >
            {t("onboarding.context.add")}
          </Button>
        </form>
      </div>

      <AiMemory onTermsAdded={(added) => setTerms((prev) => mergeTerms(prev, added))} />
    </div>
  );
}

/** How long typing must pause before an edit counts as done. */
const SETTLE_MS = 1200;

/**
 * The speaker background as one editable text, which offers edited words to
 * the dictionary. When an edit settles (a pause in typing, or leaving the
 * field) it asks about what changed: a corrected name — by the dictation rule
 * (detectCorrection), or for small edits it can't place (most Chinese ones)
 * by the model (findNameEdit) — with the old spelling as a variant; otherwise
 * the whole word the edit landed in (editedWord), never a lone character.
 * Only edits ask: selecting text doesn't. Words
 * already among the terms, and sentences, aren't offered.
 */
function BackgroundEditor({
  terms,
  onTermLearned,
}: Readonly<{ terms: readonly AddedTerm[]; onTermLearned: (term: AddedTerm) => void }>) {
  const { t } = useI18n();
  const background = useStore((s) => s.settings.userBackground);
  const patch = useStore((s) => s.updateSettings);
  /** `from`: a corrected spelling, kept as a variant (corrections only). */
  const [suggest, setSuggest] = useState<{ from?: string; to: string } | null>(null);

  /** Offer `raw` unless it isn't a term, or the dictionary already has it. */
  function offer(raw: string, from?: string) {
    const to = termCandidate(raw);
    if (!to) return;
    if (terms.some((term) => term.phrase === to) || listEntries().some((e) => e.phrase === to)) return;
    setSuggest({ from, to });
  }
  // The text as of the last settled edit: what the next edit is compared to.
  const baseline = useRef(background);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function settle() {
    clearTimeout(timer.current);
    const before = baseline.current;
    const after = useStore.getState().settings.userBackground;
    baseline.current = after;
    if (before === after) return;
    await whenDictionaryReady();
    const settings = useStore.getState().settings;
    const hit =
      detectCorrection(before, after, before, recognitionTerms(settings)) ??
      (await findNameEdit({ settings, before, after }).catch((e) => {
        log.warn("onboarding: checking the background edit failed", { error: String(e) });
        return null;
      }));
    // A newer edit has settled meanwhile: this suggestion is stale.
    if (baseline.current !== after) return;
    if (hit) {
      if (!isIgnoredTwice(hit.from, hit.to)) offer(hit.to, hit.from);
      return;
    }
    // Not a correction the rules or the model could place: offer the whole
    // word the edit landed in (fixing 昇 in 東昇 offers 東森, not 森), with its
    // old spelling as a variant when there was one.
    const word = editedWord(before, after);
    if (word) offer(word.to, word.from && word.from !== word.to ? word.from : undefined);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="onboarding-background" className="text-sm text-[#333] dark:text-foreground">
        {t("onboarding.context.background")}
      </label>
      <Textarea
        id="onboarding-background"
        value={background}
        placeholder={t("onboarding.context.backgroundPlaceholder")}
        className="h-24 min-h-24 rounded-[10px] border-[#dadee5] px-2.5 py-2 text-sm leading-[22.75px] dark:border-input"
        onChange={(e) => {
          patch({ userBackground: e.target.value });
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void settle(), SETTLE_MS);
        }}
        onBlur={() => void settle()}
      />
      {suggest && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("onboarding.context.suggestTerm", { term: suggest.to })}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => {
              const { from, to } = suggest;
              setSuggest(null);
              (from ? learnTerm(from, to).then((term) => (term ? [term] : [])) : addTerms([to]))
                .then((added) => added.forEach(onTermLearned))
                .catch((e) => log.warn("onboarding: adding a background term failed", { error: String(e) }));
            }}
          >
            <Plus className="size-3" />
            {t("onboarding.context.suggestAdd")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => {
              // Turning down a correction twice stops it being offered again.
              if (suggest.from) recordIgnore(suggest.from, suggest.to);
              setSuggest(null);
            }}
          >
            {t("onboarding.context.suggestDismiss")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** How the memory came out: condensed into `count` lines, earlier notes kept,
 *  or not condensed — `why` ("needLlm", or the error), and whether the lines
 *  shown are an excerpt of it (false when earlier notes were kept instead). */
type MemoryOutcome =
  | { kind: "condensed"; count: number }
  | { kind: "kept" }
  | { kind: "notCondensed"; why: "needLlm" | { failed: string }; excerpt: boolean };

/** Each line of the reading log shows this long before the next one. */
const LOG_STEP_MS = 420;
/** The finished log stays up this long before the result replaces it. */
const LOG_HOLD_MS = 700;

/**
 * Claude Code's memory, condensed. Every time the step opens it plays a
 * reading log — each file read, then the condensing — and when that's done
 * the log gives way to the result: the condensed lines, read-only. Earlier
 * notes are kept rather than condensed again (Refresh does that); the
 * company, people and product names in the memory join the terms above. With
 * no memory on this machine the section isn't there at all. When it can't be
 * condensed (no AI provider, or the call failed) the result is a few lines
 * taken straight from it (excerptMemory), saying why, with Retry.
 */
function AiMemory({ onTermsAdded }: Readonly<{ onTermsAdded: (terms: AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const notes = useStore((s) => s.settings.aiMemoryNotes);
  const patch = useStore((s) => s.updateSettings);
  const [reduced] = useState(prefersReducedMotion);
  // One read of the memory; `condense` is false when earlier notes may stand.
  const [run, setRun] = useState(() => ({ n: 0, condense: false }));
  const [steps, setSteps] = useState<ReadingStep[] | null>(null);
  const [outcome, setOutcome] = useState<MemoryOutcome | "hidden" | null>(() =>
    isTauri() ? null : notes.trim() ? { kind: "kept" } : "hidden",
  );
  // Log lines on screen, the condensing line last; then the result.
  const [shown, setShown] = useState(0);
  const [showResult, setShowResult] = useState(!isTauri());

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    setSteps(null);
    setOutcome(null);
    setShown(0);
    setShowResult(false);
    (async (): Promise<MemoryOutcome | "hidden"> => {
      const files = await ipc.readClaudeMemory();
      const kept = useStore.getState().settings.aiMemoryNotes.trim() !== "";
      if (files.length === 0) return kept ? { kind: "kept" } : "hidden";
      if (alive) setSteps(readingSteps(files));
      if (kept && !run.condense) return { kind: "kept" };
      const text = memoryFilesToText(files);
      // Not condensed: say why, and show what can be read off the text —
      // unless notes are already kept (a Refresh that failed), which stay.
      const fallback = (why: "needLlm" | { failed: string }): MemoryOutcome => {
        if (useStore.getState().settings.aiMemoryNotes.trim()) return { kind: "notCondensed", why, excerpt: false };
        const lines = excerptMemory(text);
        if (lines.length > 0) patch({ aiMemoryNotes: lines.join("\n") });
        return { kind: "notCondensed", why, excerpt: lines.length > 0 };
      };
      const settings = useStore.getState().settings;
      if (!isProviderReady(settings, "realtime")) return fallback("needLlm");
      try {
        const summary = await summarizeMemory({ settings, text });
        if (!alive) return "hidden";
        // The names go to the dictionary even when there are no notes to show.
        const added = await addTerms(summary.terms);
        if (added.length > 0) onTermsAdded(added);
        if (summary.notes.length === 0) return "hidden";
        patch({ aiMemoryNotes: summary.notes.join("\n") });
        return { kind: "condensed", count: summary.notes.length };
      } catch (e) {
        log.warn("onboarding: condensing AI memory failed", { error: String(e) });
        return fallback({ failed: describeAiError(e) });
      }
    })()
      .then((next) => alive && setOutcome(next))
      .catch((e) => {
        log.warn("onboarding: reading AI memory failed", { error: String(e) });
        if (alive) setOutcome("hidden");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // Reveal the log a line at a time: the files, then the condensing line.
  const total = steps ? steps.length + 1 : 0;
  useEffect(() => {
    if (!steps) return;
    if (reduced) {
      setShown(total);
      return;
    }
    if (shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 0 : LOG_STEP_MS);
    return () => clearTimeout(id);
  }, [steps, shown, total, reduced]);

  // Once the log is out and the outcome is in, hold it a beat, then the result.
  const logDone = outcome !== null && (steps === null || shown >= total);
  useEffect(() => {
    if (!logDone || showResult) return;
    const id = setTimeout(() => setShowResult(true), reduced || steps === null ? 0 : LOG_HOLD_MS);
    return () => clearTimeout(id);
  }, [logDone, showResult, reduced, steps]);

  if (outcome === "hidden") return null;

  const lines = backgroundLines(notes);
  const notCondensed = outcome?.kind === "notCondensed" ? outcome : null;
  let why = "";
  if (notCondensed?.why === "needLlm") why = t("onboarding.context.memory.needLlm");
  else if (notCondensed) why = t("onboarding.context.memory.failed", { error: notCondensed.why.failed });

  let condenseLine = t("onboarding.context.memory.condensing");
  if (outcome?.kind === "condensed") condenseLine = t("onboarding.context.memory.condensed", { count: outcome.count });
  else if (outcome?.kind === "kept") condenseLine = t("onboarding.context.memory.kept");
  else if (notCondensed) condenseLine = t("onboarding.context.memory.notCondensed");

  const box =
    "flex min-h-[92px] flex-1 flex-col gap-0.5 overflow-y-auto rounded-[8px] bg-[#f5f7f9] p-3 text-[13px] leading-[21.125px] text-[#333] dark:bg-muted dark:text-foreground";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-sm text-[#333] dark:text-foreground">{t("onboarding.context.memory.title")} · </span>
          <span className="text-xs text-muted-foreground">{t("onboarding.context.memory.source")}</span>
        </span>
        {showResult && isTauri() && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-primary"
            onClick={() => setRun((r) => ({ n: r.n + 1, condense: true }))}
          >
            <RotateCcw className="size-3" />
            {notCondensed ? t("onboarding.context.memory.retry") : t("onboarding.context.memory.refresh")}
          </Button>
        )}
      </div>
      {showResult ? (
        <>
          {notCondensed && (
            <p className="ob-fade-in text-[11px] leading-relaxed text-muted-foreground">
              {why} {notCondensed.excerpt && t("onboarding.context.memory.excerpt")}
            </p>
          )}
          {lines.length > 0 && (
            // Takes the rest of the dialog's height (never under about three
            // lines); a longer memory scrolls inside it.
            <ul className={cn(box, "ob-fade-in")}>
              {lines.map((line, i) => (
                <li key={`${i}:${line}`} className="flex gap-2">
                  <span>•</span>
                  <span className="flex-1">{line}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        // The reading log, in the box the result will fill.
        <ul aria-live="polite" className={cn(box, "text-muted-foreground")}>
          {steps === null ? (
            <LogLine done={false} text={t("onboarding.context.memory.looking")} />
          ) : (
            <>
              {steps.slice(0, shown).map((step, i) => (
                <LogLine
                  key={i}
                  // A file line ticks when the next line comes in.
                  done={i < shown - 1}
                  text={
                    step.kind === "auto"
                      ? t("onboarding.context.memory.readAuto", { count: step.count })
                      : t("onboarding.context.memory.readFile", { name: step.name })
                  }
                />
              ))}
              {shown > steps.length && <LogLine done={outcome !== null} text={condenseLine} />}
            </>
          )}
        </ul>
      )}
    </div>
  );
}

function LogLine({ done, text }: Readonly<{ done: boolean; text: string }>) {
  return (
    <li className="ob-rise flex items-center gap-2">
      {done ? (
        <Check className="size-3.5 shrink-0 text-primary" />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      )}
      <span className={cn("min-w-0 flex-1 truncate", done && "text-[#333] dark:text-foreground")}>{text}</span>
    </li>
  );
}
