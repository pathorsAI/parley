import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Info, Loader2, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { removeEntry } from "../../lib/dictionary";
import { draftBackground, memoryFilesToText, readingSteps, type ReadingStep } from "../../lib/onboarding/memoryImport";
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
 * - how they work: Claude Code's memory files on this machine, read when the
 *   step opens and used to fill in the background in a fixed template, with
 *   a log of what was read.
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

      <AiMemory
        onTermsAdded={(added) => setTerms((prev) => mergeTerms(prev, added))}
        onBackgroundWritten={() => setWritten((n) => n + 1)}
      />
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
}: Readonly<{ written: number; terms: readonly AddedTerm[]; onTermLearned: (term: AddedTerm) => void }>) {
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
      <label htmlFor="onboarding-background" className="text-sm text-[#333] dark:text-foreground">
        {t("onboarding.context.background")}
      </label>
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

/** Each line of the reading log shows this long before the next one. */
const LOG_STEP_MS = 420;

/**
 * "How you work": Claude Code's memory files on this machine, used to fill in
 * the speaker background above. A reading log plays as it happens — each
 * file read, then the writing — and stays as the record of what was read; the
 * result is the background itself. Done once (settings.aiMemoryNotes keeps
 * what was written): a revisit replays the read without rewriting the user's
 * edits, and Refresh writes it again from the background as it stands. With
 * no memory on this machine the section isn't there at all. Without an AI
 * provider nothing is written, and the last line says so.
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
  const [steps, setSteps] = useState<ReadingStep[] | null>(null);
  const [outcome, setOutcome] = useState<MemoryOutcome | "hidden" | null>(() => (isTauri() ? null : "hidden"));
  // Log lines on screen: the files, then the writing line.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    setSteps(null);
    setOutcome(null);
    setShown(0);
    (async (): Promise<MemoryOutcome | "hidden"> => {
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "hidden";
      if (alive) setSteps(readingSteps(files));
      const settings = useStore.getState().settings;
      if (settings.aiMemoryNotes.trim() && !run.write) return { kind: "kept" };
      if (!isProviderReady(settings, "realtime")) return { kind: "needLlm" };
      try {
        const draft = await draftBackground({
          settings,
          current: settings.userBackground,
          text: memoryFilesToText(files),
        });
        if (!alive) return "hidden";
        // The names go to the dictionary even when there's no background to write.
        const added = await addTerms(draft.terms);
        if (added.length > 0) onTermsAdded(added);
        if (draft.background.length === 0) return { kind: "nothing" };
        const text = draft.background.join("\n");
        patch({ userBackground: text, aiMemoryNotes: text });
        onBackgroundWritten();
        return { kind: "written" };
      } catch (e) {
        log.warn("onboarding: filling in the background from memory failed", { error: String(e) });
        return { kind: "failed", error: describeAiError(e) };
      }
    })()
      .then((next) => alive && setOutcome(next))
      .catch((e) => {
        log.warn("onboarding: reading Claude Code memory failed", { error: String(e) });
        if (alive) setOutcome("hidden");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // Reveal the log a line at a time: the files, then the writing line.
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

  if (outcome === "hidden") return null;

  const finished = outcome !== null && steps !== null && shown >= total;
  let last = t("onboarding.context.memory.writing");
  if (outcome?.kind === "written") last = t("onboarding.context.memory.written");
  else if (outcome?.kind === "kept") last = t("onboarding.context.memory.kept");
  else if (outcome?.kind === "nothing") last = t("onboarding.context.memory.nothing");
  else if (outcome?.kind === "needLlm") last = t("onboarding.context.memory.needLlm");
  else if (outcome?.kind === "failed") last = t("onboarding.context.memory.failed", { error: outcome.error });
  let lastIcon: LogIcon = "spin";
  if (outcome?.kind === "failed") lastIcon = "error";
  else if (outcome?.kind === "needLlm") lastIcon = "info";
  else if (outcome) lastIcon = "done";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-sm text-[#333] dark:text-foreground">{t("onboarding.context.memory.title")} · </span>
          <span className="text-xs text-muted-foreground">{t("onboarding.context.memory.source")}</span>
        </span>
        {finished && outcome.kind !== "needLlm" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-primary"
            onClick={() => setRun((r) => ({ n: r.n + 1, write: true }))}
          >
            <RotateCcw className="size-3" />
            {outcome.kind === "failed" ? t("onboarding.context.memory.retry") : t("onboarding.context.memory.refresh")}
          </Button>
        )}
      </div>
      {/* What was read: a log that plays while it happens and stays after. */}
      <ul
        aria-live="polite"
        className="flex max-h-[148px] flex-col gap-0.5 overflow-y-auto rounded-[8px] bg-[#f5f7f9] p-3 text-[13px] leading-[21.125px] text-muted-foreground dark:bg-muted"
      >
        {steps === null ? (
          <LogLine icon="spin" text={t("onboarding.context.memory.looking")} />
        ) : (
          <>
            {steps.slice(0, shown).map((step, i) => (
              <LogLine
                key={i}
                // A file line ticks when the next line comes in.
                icon={i < shown - 1 ? "done" : "spin"}
                text={
                  step.kind === "auto"
                    ? t("onboarding.context.memory.readAuto", { count: step.count })
                    : t("onboarding.context.memory.readFile", { name: step.name })
                }
              />
            ))}
            {shown > steps.length && <LogLine icon={lastIcon} text={last} />}
          </>
        )}
      </ul>
    </div>
  );
}

type LogIcon = "spin" | "done" | "info" | "error";

function LogLine({ icon, text }: Readonly<{ icon: LogIcon; text: string }>) {
  return (
    <li className="ob-rise flex items-center gap-2">
      {icon === "spin" && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
      {icon === "done" && <Check className="size-3.5 shrink-0 text-primary" />}
      {icon === "info" && <Info className="size-3.5 shrink-0" />}
      {icon === "error" && <CircleAlert className="size-3.5 shrink-0 text-destructive" />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          icon === "done" && "text-[#333] dark:text-foreground",
          icon === "error" && "text-destructive",
        )}
        title={text}
      >
        {text}
      </span>
    </li>
  );
}
