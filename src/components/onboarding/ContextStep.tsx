import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { removeEntry } from "../../lib/dictionary";
import { backgroundLines, memoryFilesToText, summarizeMemory } from "../../lib/onboarding/memoryImport";
import {
  addTerms,
  changedSpan,
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
 *  to show. "needLlm" / failed: there is memory, but it couldn't be condensed. */
type MemoryState = "reading" | "ready" | "hidden" | "needLlm" | { failed: string };

/**
 * What every meeting prompt should know about the user:
 * - the speaker background (settings.userBackground), seeded by the
 *   self-introduction in the mic check, edited here as free text; selecting
 *   or editing a few words in it offers them to the dictionary;
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
 * The speaker background as one editable text, which offers words in it to
 * the dictionary:
 * - selecting a few words asks whether to add them;
 * - when an edit settles (a pause in typing, or leaving the field) it asks
 *   about what changed. A corrected name — by the dictation rule
 *   (detectCorrection), or for small edits it can't place (most Chinese ones)
 *   by the model (findNameEdit) — is offered with the old spelling as a
 *   variant; any other short insertion is offered as it is.
 * Words already among the terms, and sentences, aren't offered.
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

  const field = useRef<HTMLTextAreaElement | null>(null);
  // Selecting words offers them. The native `select` event is the one both
  // webviews fire for a textarea (React's onSelect doesn't, reliably);
  // mouseup / keyup catch a selection made some other way.
  function offerSelection() {
    const el = field.current;
    if (el && el.selectionEnd > el.selectionStart) offer(el.value.slice(el.selectionStart, el.selectionEnd));
  }
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.addEventListener("select", offerSelection);
    return () => el.removeEventListener("select", offerSelection);
  });

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
    // Not a correction: offer what was typed in, if it is a name's length.
    const typed = changedSpan(before, after).to;
    if (typed.trim()) offer(typed);
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
        onMouseUp={offerSelection}
        onKeyUp={offerSelection}
        ref={field}
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
 * earlier visit already kept a summary); the company, people and product
 * names in it join the terms above, the rest is shown read-only. With no
 * memory on this machine the section isn't there at all; with memory that
 * couldn't be condensed (no AI provider, or the call failed) it is one line
 * saying why.
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
      // between staying out of the way and saying why it can't be used.
      const files = await ipc.readClaudeMemory();
      if (files.length === 0) return "hidden";
      const settings = useStore.getState().settings;
      if (!isProviderReady(settings, "realtime")) return "needLlm";
      try {
        const summary = await summarizeMemory({ settings, text: memoryFilesToText(files) });
        if (!alive) return "hidden";
        // The names go to the dictionary even when there are no notes to show.
        const added = await addTerms(summary.terms);
        if (added.length > 0) onTermsAdded(added);
        if (summary.notes.length === 0) return "hidden";
        patch({ aiMemoryNotes: summary.notes.join("\n") });
        return "ready";
      } catch (e) {
        log.warn("onboarding: condensing AI memory failed", { error: String(e) });
        return { failed: describeAiError(e) };
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
  }, []);

  if (state === "hidden") return null;

  // Memory exists but couldn't be used: one line saying why, not the section.
  if (state === "needLlm" || typeof state === "object") {
    return (
      <p className="flex items-center gap-1.5 border-t pt-4 text-xs text-muted-foreground">
        <Sparkles className="size-3 shrink-0 text-primary" />
        {state === "needLlm"
          ? t("onboarding.context.memory.needLlm")
          : t("onboarding.context.memory.failed", { error: state.failed })}
      </p>
    );
  }

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
