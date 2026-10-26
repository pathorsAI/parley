import { useState } from "react";
import { Check, ChevronDown, ChevronRight, ClipboardPaste, Copy, Loader2, Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import { isProviderReady } from "../../lib/ai/settings";
import { describeAiError } from "../../lib/ai/errors";
import { addEntry, removeEntry, whenDictionaryReady } from "../../lib/dictionary";
import {
  backgroundLines,
  joinBackground,
  memoryFilesToText,
  mergeBackground,
  summarizeMemory,
  type MemorySummary,
} from "../../lib/onboarding/memoryImport";
import * as ipc from "../../lib/ipc/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Status = { kind: "info" | "error"; text: string } | null;

/** A dictionary entry this step created, so it can take it back out. */
type AddedTerm = { id: string; phrase: string };

/**
 * What every meeting prompt should know about the user: the speaker background
 * (settings.userBackground, one fact per line) and the terms transcription
 * should spell right (the shared dictionary). Both can be seeded from what the
 * user's AI assistants already remember — Claude Code's memory files, or
 * ChatGPT's memory pasted back — boiled down by the user's own LLM.
 */
export function ContextStep() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const lines = backgroundLines(settings.userBackground);
  const llmReady = isProviderReady(settings, "realtime");

  const [newLine, setNewLine] = useState("");
  const [terms, setTerms] = useState<AddedTerm[]>([]);
  const [newTerm, setNewTerm] = useState("");
  const [busy, setBusy] = useState<"claude" | "chatgpt" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [chatGptOpen, setChatGptOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);

  async function addTerms(phrases: readonly string[]): Promise<number> {
    await whenDictionaryReady();
    const added: AddedTerm[] = [];
    for (const phrase of phrases) {
      // A phrase already in the dictionary merges as a variant (or not at all);
      // only brand-new entries are listed here, so removing one never deletes
      // something the user had before onboarding.
      const res = addEntry({ phrase, source: "manual" });
      if (res?.kind === "entry") added.push({ id: res.entryId, phrase: phrase.trim() });
    }
    setTerms((prev) => [...prev, ...added]);
    return added.length;
  }

  async function apply(summary: MemorySummary) {
    const before = lines.length;
    const merged = mergeBackground(useStore.getState().settings.userBackground, summary.background);
    patch({ userBackground: merged });
    const addedLines = backgroundLines(merged).length - before;
    const addedTerms = await addTerms(summary.terms);
    setStatus({
      kind: "info",
      text:
        addedLines + addedTerms === 0
          ? t("onboarding.context.nothingNew")
          : t("onboarding.context.added", { lines: addedLines, terms: addedTerms }),
    });
  }

  async function run(source: "claude" | "chatgpt") {
    setBusy(source);
    setStatus(null);
    try {
      let text: string;
      if (source === "claude") {
        const files = await ipc.readClaudeMemory();
        if (files.length === 0) {
          setStatus({ kind: "info", text: t("onboarding.context.noClaude") });
          return;
        }
        text = memoryFilesToText(files);
      } else {
        text = pasted;
      }
      await apply(await summarizeMemory({ settings: useStore.getState().settings, text }));
      if (source === "chatgpt") setPasted("");
    } catch (e) {
      log.warn("onboarding: memory import failed", { source, error: String(e) });
      setStatus({ kind: "error", text: t("onboarding.context.failed", { error: describeAiError(e) }) });
    } finally {
      setBusy(null);
    }
  }

  function addLine() {
    const v = newLine.trim();
    if (!v) return;
    patch({ userBackground: mergeBackground(settings.userBackground, [v]) });
    setNewLine("");
  }

  function addTypedTerm() {
    const v = newTerm.trim();
    if (!v) return;
    setNewTerm("");
    addTerms([v]).catch((e) => log.warn("onboarding: add term failed", { error: String(e) }));
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(t("onboarding.context.chatgptPrompt"));
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1500);
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
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 px-3 py-2.5">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              disabled={!llmReady || busy !== null || !isTauri()}
              onClick={() => {
                run("claude").catch((e) => log.error("onboarding: claude memory import failed", { error: String(e) }));
              }}
            >
              {busy === "claude" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {busy === "claude" ? t("onboarding.context.reading") : t("onboarding.context.claude")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              disabled={!llmReady || busy !== null}
              aria-expanded={chatGptOpen}
              onClick={() => setChatGptOpen((o) => !o)}
            >
              <ClipboardPaste className="size-3.5" />
              {t("onboarding.context.chatgpt")}
              {chatGptOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {llmReady ? t("onboarding.context.importNote") : t("onboarding.context.needLlm")}
          </p>

          {chatGptOpen && llmReady && (
            <div className="flex flex-col gap-2 border-t pt-2">
              <span className="text-[11px] text-muted-foreground">{t("onboarding.context.chatgptStep1")}</span>
              <div className="flex items-start gap-2 rounded-md bg-background px-2.5 py-2 text-xs leading-relaxed">
                <span className="flex-1">{t("onboarding.context.chatgptPrompt")}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
                  onClick={() => {
                    copyPrompt().catch((e) => log.warn("onboarding: copy prompt failed", { error: String(e) }));
                  }}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? t("onboarding.context.copied") : t("onboarding.context.copy")}
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">{t("onboarding.context.chatgptStep2")}</span>
              <Textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                aria-label={t("onboarding.context.chatgptStep2")}
                className="min-h-20 text-xs"
              />
              <Button
                size="sm"
                className="h-7 w-fit gap-1.5 text-[11px]"
                disabled={!pasted.trim() || busy !== null}
                onClick={() => {
                  run("chatgpt").catch((e) =>
                    log.error("onboarding: chatgpt memory import failed", { error: String(e) }),
                  );
                }}
              >
                {busy === "chatgpt" && <Loader2 className="size-3.5 animate-spin" />}
                {busy === "chatgpt" ? t("onboarding.context.reading") : t("onboarding.context.summarize")}
              </Button>
            </div>
          )}

          {status && (
            <p
              className={`rounded-md px-2.5 py-1.5 text-[11px] ${
                status.kind === "error" ? "bg-danger text-danger-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {status.text}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
          {lines.length === 0 && (
            <p className="py-1 text-[13px] text-muted-foreground">{t("onboarding.context.empty")}</p>
          )}
          {lines.map((line, i) => (
            <div key={line} className="flex items-start gap-2 py-0.5 text-[13px] leading-relaxed">
              <span className="text-muted-foreground">•</span>
              <span className="flex-1">{line}</span>
              <button
                type="button"
                aria-label={t("onboarding.context.removeLine")}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => patch({ userBackground: joinBackground(lines.filter((_, k) => k !== i)) })}
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
            <span
              key={term.id}
              className="inline-flex h-6 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs"
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
            className="h-6 w-28 rounded-full border-dashed px-2.5 text-xs"
          />
          <Button type="submit" variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary" disabled={!newTerm.trim()}>
            {t("onboarding.context.add")}
          </Button>
        </form>
      </div>
    </div>
  );
}
