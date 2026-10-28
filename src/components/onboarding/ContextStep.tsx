import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { removeEntry } from "../../lib/dictionary";
import { backgroundLines, excerptMemory, memoryFilesToText, summarizeMemory } from "../../lib/onboarding/memoryImport";
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

/** "hidden": no memory on this machine (or not the desktop app), so nothing
 *  to show. An object: there is memory, but it couldn't be condensed — `why`
 *  ("needLlm", or the error), and whether the lines shown are an excerpt of it
 *  (false when earlier notes were kept instead). */
type MemoryState = "reading" | "ready" | "hidden" | { why: "needLlm" | { failed: string }; excerpt: boolean };

/**
 * What every meeting prompt should know about the user:
 * - the speaker background (settings.userBackground), seeded by the
 *   self-introduction in the mic check, edited here as free text; editing a
 *   few words in it offers them to the dictionary;
 * - the terms transcription should spell right (the shared dictionary): the
 *   user's name and company, the company, people and product names from the
 *   self-introduction and the AI memory, and any the user types — removable;
 * - what their AI assistant remembers (settings.aiMemoryNotes): Claude Code's
 *   memory files, read and condensed when the step opens, shown read-only so
 *   the user can see what was taken.
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.context.body")}</p>
      </div>

      {/* Speaker background */}
      <BackgroundEditor
        terms={terms}
        onTermLearned={(term) => setTerms((prev) => mergeTerms(prev, [term]))}
      />

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
      <label htmlFor="onboarding-background" className="text-xs text-muted-foreground">
        {t("onboarding.context.background")}
      </label>
      <Textarea
        id="onboarding-background"
        value={background}
        placeholder={t("onboarding.context.backgroundPlaceholder")}
        className="min-h-24 text-[13px] leading-relaxed"
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

/**
 * Claude Code's memory, condensed. Read once when the step opens (unless an
 * earlier visit already kept notes); the company, people and product names in
 * it join the terms above, the rest is shown read-only. With no memory on this
 * machine the section isn't there at all. When it can't be condensed (no AI
 * provider, or the call failed) the section shows a few lines taken straight
 * from it instead (excerptMemory), saying why; either way Refresh tries the
 * model again.
 */
function AiMemory({ onTermsAdded }: Readonly<{ onTermsAdded: (terms: AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const notes = useStore((s) => s.settings.aiMemoryNotes);
  const patch = useStore((s) => s.updateSettings);
  const [state, setState] = useState<MemoryState>(() => {
    if (notes.trim()) return "ready";
    return isTauri() ? "reading" : "hidden";
  });

  useEffect(() => {
    if (state !== "reading") return;
    let alive = true;
    (async (): Promise<MemoryState> => {
      // Reading the files needs no AI; whether there is memory at all decides
      // between staying out of the way and showing what can be done with it.
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "hidden";
      const text = memoryFilesToText(files);
      // Not condensed: say why, and show what can be read off the text —
      // unless notes are already kept (a Refresh that failed), which stay.
      const fallback = (why: "needLlm" | { failed: string }): MemoryState => {
        if (useStore.getState().settings.aiMemoryNotes.trim()) return { why, excerpt: false };
        const lines = excerptMemory(text);
        if (lines.length > 0) patch({ aiMemoryNotes: lines.join("\n") });
        return { why, excerpt: lines.length > 0 };
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
        return "ready";
      } catch (e) {
        log.warn("onboarding: condensing AI memory failed", { error: String(e) });
        return fallback({ failed: describeAiError(e) });
      }
    })()
      .then((next) => alive && setState(next))
      .catch((e) => {
        log.warn("onboarding: reading AI memory failed", { error: String(e) });
        if (alive) setState("hidden");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (state === "hidden") return null;

  const lines = backgroundLines(notes);
  const notCondensed = typeof state === "object" ? state : null;
  let why = "";
  if (notCondensed?.why === "needLlm") why = t("onboarding.context.memory.needLlm");
  else if (notCondensed) why = t("onboarding.context.memory.failed", { error: notCondensed.why.failed });

  return (
    <div className="flex flex-col gap-1.5 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3 text-primary" />
          {t("onboarding.context.memory.title")}
        </span>
        {state !== "reading" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-primary"
            onClick={() => setState("reading")}
          >
            <RotateCcw className="size-3" />
            {notCondensed ? t("onboarding.context.memory.retry") : t("onboarding.context.memory.refresh")}
          </Button>
        )}
      </div>
      {notCondensed && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {why} {notCondensed.excerpt && t("onboarding.context.memory.excerpt")}
        </p>
      )}
      {state === "reading" ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("onboarding.context.memory.reading")}
        </p>
      ) : (
        lines.length > 0 && (
          <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-relaxed">
            {lines.map((line, i) => (
              <li key={`${i}:${line}`} className="flex gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="flex-1">{line}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
