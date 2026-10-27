import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { removeEntry } from "../../lib/dictionary";
import { backgroundLines, memoryFilesToText, summarizeMemory } from "../../lib/onboarding/memoryImport";
import { addTerms, findNameEdit, learnTerm, mergeTerms, type AddedTerm } from "../../lib/onboarding/micCheck";
import { detectCorrection } from "../../lib/dictionary/diffCorrection";
import { isIgnoredTwice, recognitionTerms, recordIgnore, whenDictionaryReady } from "../../lib/dictionary";
import * as ipc from "../../lib/ipc/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type MemoryState = "reading" | "ready" | "hidden";

/**
 * What every meeting prompt should know about the user:
 * - the speaker background (settings.userBackground), seeded by the
 *   self-introduction in the mic check, edited here as free text; correcting
 *   a name in it offers that name to the dictionary;
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

  // The names already known go straight in: the user's own name and company
  // (Settings, or filled from the self-introduction). No AI needed for these.
  useEffect(() => {
    const { userName, userCompany } = useStore.getState().settings;
    addTerms([userCompany, userName])
      .then((found) => setTerms((prev) => mergeTerms(prev, found)))
      .catch((e) => log.warn("onboarding: adding profile terms failed", { error: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <h2 className="text-base font-semibold tracking-tight">{t("onboarding.context.title")}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.context.body")}</p>
      </div>

      {/* Speaker background */}
      <BackgroundEditor onTermLearned={(term) => setTerms((prev) => mergeTerms(prev, [term]))} />

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
 * The speaker background as one editable text. When an edit settles (a pause
 * in typing, or leaving the field) and it looks like a corrected name, it
 * offers the corrected name to the dictionary, with the old spelling as a
 * variant. The test is the one for fixing a word in a dictation
 * (detectCorrection), so new sentences and rewrites don't count; for small
 * edits it can't place (most Chinese ones), the model is asked (findNameEdit).
 */
function BackgroundEditor({ onTermLearned }: Readonly<{ onTermLearned: (term: AddedTerm) => void }>) {
  const { t } = useI18n();
  const background = useStore((s) => s.settings.userBackground);
  const patch = useStore((s) => s.updateSettings);
  const [suggest, setSuggest] = useState<{ from: string; to: string } | null>(null);
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
    if (hit && !isIgnoredTwice(hit.from, hit.to)) setSuggest(hit);
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
              learnTerm(from, to)
                .then((term) => term && onTermLearned(term))
                .catch((e) => log.warn("onboarding: learning a corrected term failed", { error: String(e) }));
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
              recordIgnore(suggest.from, suggest.to);
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
 * earlier visit already kept a summary); the company, people and product
 * names in it join the terms above, the rest is shown read-only — and not shown at
 * all when there is no memory, no AI provider to condense it, or the read
 * failed.
 */
function AiMemory({ onTermsAdded }: Readonly<{ onTermsAdded: (terms: AddedTerm[]) => void }>) {
  const { t } = useI18n();
  const notes = useStore((s) => s.settings.aiMemoryNotes);
  const patch = useStore((s) => s.updateSettings);
  const [state, setState] = useState<MemoryState>(() => {
    if (notes.trim()) return "ready";
    return isTauri() && isProviderReady(useStore.getState().settings, "realtime") ? "reading" : "hidden";
  });

  useEffect(() => {
    if (state !== "reading") return;
    let alive = true;
    (async () => {
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "hidden" as const;
      const summary = await summarizeMemory({ settings: useStore.getState().settings, text: memoryFilesToText(files) });
      if (!alive) return "hidden" as const;
      // The names go to the dictionary even when there are no notes to show.
      const added = await addTerms(summary.terms);
      if (added.length > 0) onTermsAdded(added);
      if (summary.notes.length === 0) return "hidden" as const;
      patch({ aiMemoryNotes: summary.notes.join("\n") });
      return "ready" as const;
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
  }, []);

  // Nothing found, no AI provider, or a failed read: the section just isn't
  // there — the step stands without it.
  if (state !== "reading" && state !== "ready") return null;
  const lines = backgroundLines(notes);

  return (
    <div className="flex flex-col gap-1.5 border-t pt-4">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3 text-primary" />
        {t("onboarding.context.memory.title")}
      </span>
      {state === "reading" ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("onboarding.context.memory.reading")}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-relaxed">
          {lines.map((line, i) => (
            <li key={`${i}:${line}`} className="flex gap-2">
              <span className="text-muted-foreground">•</span>
              <span className="flex-1">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
