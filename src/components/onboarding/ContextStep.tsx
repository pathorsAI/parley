import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Info, Loader2, Plus, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
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
  draftBackground,
  memoryFilesToText,
  removeBackgroundLines,
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
 *   self-introduction in the mic check, filled in from how the user works
 *   (below), edited here as free text; editing a few words in it offers them
 *   to the dictionary;
 * - the terms transcription should spell right (the shared dictionary): the
 *   user's name and company, the company, people and product names from the
 *   self-introduction and Claude Code's memory, and any the user types — removable;
 * - how they work: the memory files on this machine, read when the step
 *   opens and added under the background in a fixed template, with a
 *   one-line status beside the background's heading.
 */
export function ContextStep({
  terms,
  setTerms,
}: Readonly<{ terms: AddedTerm[]; setTerms: (update: (prev: AddedTerm[]) => AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const [newTerm, setNewTerm] = useState("");
  // Bumped when the background is written for the user, so its box flashes.
  const [written, setWritten] = useState(0);

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
    // Fills the step; the speaker background takes whatever height is left.
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* Speaker background */}
      <BackgroundEditor
        written={written}
        terms={terms}
        onTermLearned={(term) => setTerms((prev) => mergeTerms(prev, [term]))}
        aside={
          <AiMemory
            onTermsAdded={(added) => setTerms((prev) => mergeTerms(prev, added))}
            onBackgroundWritten={() => setWritten((n) => n + 1)}
          />
        }
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
  written,
  terms,
  onTermLearned,
  aside,
}: Readonly<{
  written: number;
  terms: readonly AddedTerm[];
  onTermLearned: (term: AddedTerm) => void;
  /** Shown at the right end of the heading: how filling it in is going. */
  aside?: ReactNode;
}>) {
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
  // Written for the user, not edited by them: the next edit compares to this.
  useEffect(() => {
    if (written > 0) baseline.current = useStore.getState().settings.userBackground;
  }, [written]);

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
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <label htmlFor="onboarding-background" className="shrink-0 text-sm text-[#333] dark:text-foreground">
          {t("onboarding.context.background")}
        </label>
        {aside}
      </div>
      <Textarea
        key={written}
        id="onboarding-background"
        value={background}
        placeholder={t("onboarding.context.backgroundPlaceholder")}
        className={cn(
          "min-h-24 flex-1 resize-none rounded-[10px] border-[#dadee5] px-2.5 py-2 text-sm leading-[22.75px] dark:border-input",
          written > 0 && "ob-flash",
        )}
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

/** How filling in the background came out (or "hidden": nothing to read). */
type MemoryOutcome =
  | { kind: "written" }
  | { kind: "kept" }
  | { kind: "nothing" }
  | { kind: "needLlm" }
  | { kind: "failed"; error: string };

/** Each reading step shows at least this long before the next one. */
const STEP_MS = 1500;

/** The three steps the status line walks through while it fills in. */
const READ_STEPS = [
  "onboarding.context.memory.step.read",
  "onboarding.context.memory.step.sort",
  "onboarding.context.memory.step.write",
] as const;

/**
 * Filling in the speaker background from how the user works: the memory
 * files on this machine, written as template lines under what the user said
 * in the mic check. Shown as one status line beside the background's heading
 * that steps through reading, sorting and writing — each step replacing the
 * last — and ends on how it came out. It names no tool or file: it reads as
 * "your notes on this computer". Done once (settings.aiMemoryNotes keeps what
 * was written): a revisit replays the steps without rewriting the user's
 * edits, and Refresh writes it again from the background as it stands. With
 * no memory on this machine there is no status at all. Without an AI provider
 * nothing is written, and the last step says so.
 */
function AiMemory({
  onTermsAdded,
  onBackgroundWritten,
}: Readonly<{ onTermsAdded: (terms: AddedTerm[]) => void; onBackgroundWritten: () => void }>) {
  const { t } = useI18n();
  const patch = useStore((s) => s.updateSettings);
  const [reduced] = useState(prefersReducedMotion);
  // One read of the memory; `write` is true when the background is to be
  // written even if it was before (Refresh).
  const [run, setRun] = useState(() => ({ n: 0, write: false }));
  const [outcome, setOutcome] = useState<MemoryOutcome | "hidden" | null>(() => (isTauri() ? null : "hidden"));
  // The step on screen; READ_STEPS.length means the outcome.
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    setOutcome(null);
    setStep(0);
    (async (): Promise<MemoryOutcome | "hidden"> => {
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "hidden";
      const settings = useStore.getState().settings;
      if (settings.aiMemoryNotes.trim() && !run.write) return { kind: "kept" };
      if (!isProviderReady(settings, "realtime")) return { kind: "needLlm" };
      try {
        const draft = await draftBackground({
          settings,
          current: removeBackgroundLines(settings.userBackground, backgroundLines(settings.aiMemoryNotes)),
          text: memoryFilesToText(files),
        });
        if (!alive) return "hidden";
        // The names go to the dictionary even when there's no background to write.
        const added = await addTerms(draft.terms);
        if (added.length > 0) onTermsAdded(added);
        // Under what the user said in the mic check, in place of what an
        // earlier fill-in (Refresh) added.
        const own = removeBackgroundLines(
          useStore.getState().settings.userBackground,
          backgroundLines(useStore.getState().settings.aiMemoryNotes),
        );
        if (draft.background.length === 0) return { kind: "nothing" };
        const { text, lines } = appendBackground(own, draft.background);
        patch({ userBackground: text, aiMemoryNotes: lines.join("\n") || draft.background.join("\n") });
        onBackgroundWritten();
        return { kind: "written" };
      } catch (e) {
        log.warn("onboarding: filling in the background from memory failed", { error: String(e) });
        return { kind: "failed", error: describeAiError(e) };
      }
    })()
      .then((next) => alive && setOutcome(next))
      .catch((e) => {
        log.warn("onboarding: reading the memory files failed", { error: String(e) });
        if (alive) setOutcome("hidden");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // Step through reading and sorting on a timer; the writing step holds
  // until the outcome is in.
  useEffect(() => {
    if (outcome === "hidden") return;
    if (reduced && outcome) return setStep(READ_STEPS.length);
    const last = READ_STEPS.length - 1;
    if (step > last || (step === last && !outcome)) return;
    const id = setTimeout(() => setStep((n) => n + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [step, outcome, reduced]);

  if (outcome === "hidden") return null;

  const done = outcome !== null && step >= READ_STEPS.length;
  let icon: LogIcon = "spin";
  let text = t(READ_STEPS[Math.min(step, READ_STEPS.length - 1)]);
  let title = text;
  if (done) {
    icon = outcome.kind === "failed" ? "error" : outcome.kind === "needLlm" ? "info" : "done";
    text = t(outcome.kind === "needLlm" ? "onboarding.context.memory.needLlmShort" : `onboarding.context.memory.${outcome.kind}`);
    if (outcome.kind === "failed") title = t("onboarding.context.memory.failedLong", { error: outcome.error });
    else if (outcome.kind === "needLlm") title = t("onboarding.context.memory.needLlm");
    else title = text;
  }

  return (
    <div aria-live="polite" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {/* Keyed by step, so each one comes in as the last goes. */}
      <StatusLine key={done ? "done" : step} icon={icon} text={text} title={title} />
      {done && outcome.kind !== "needLlm" && (
        <button
          type="button"
          aria-label={outcome.kind === "failed" ? t("onboarding.context.memory.retry") : t("onboarding.context.memory.refresh")}
          title={outcome.kind === "failed" ? t("onboarding.context.memory.retry") : t("onboarding.context.memory.refresh")}
          onClick={() => setRun((r) => ({ n: r.n + 1, write: true }))}
          className="grid size-5 shrink-0 place-items-center rounded text-primary transition-colors hover:bg-primary/10"
        >
          <RotateCcw className="size-3" />
        </button>
      )}
    </div>
  );
}

type LogIcon = "spin" | "done" | "info" | "error";

function StatusLine({ icon, text, title }: Readonly<{ icon: LogIcon; text: string; title: string }>) {
  return (
    <span className="ob-rise flex min-w-0 items-center gap-1.5">
      {icon === "spin" && <Loader2 className="size-3 shrink-0 animate-spin" />}
      {icon === "done" && <Check className="size-3 shrink-0 text-primary" />}
      {icon === "info" && <Info className="size-3 shrink-0" />}
      {icon === "error" && <CircleAlert className="size-3 shrink-0 text-destructive" />}
      <span className={cn("min-w-0 truncate", icon === "error" && "text-destructive")} title={title}>
        {text}
      </span>
    </span>
  );
}
