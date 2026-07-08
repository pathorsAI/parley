import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, meetingBriefText } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

const SUGGESTIONS: TranslationKey[] = [
  "ask.suggestion.next",
  "ask.suggestion.agreed",
  "ask.suggestion.unanswered",
  "ask.suggestion.pushback",
  "ask.suggestion.summary",
];

export function AskPanel() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const segmentCount = useStore((s) => s.segments.length);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Rotate the ghost suggestion in the input while it's empty.
  useEffect(() => {
    if (input) return;
    const id = setInterval(
      () => setSuggestionIdx((i) => (i + 1) % SUGGESTIONS.length),
      4000
    );
    return () => clearInterval(id);
  }, [input]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    ask(input).catch((error) => log.error("ask: submit failed", { error: String(error) }));
  }

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setInput("");
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: q }]);

    const state = useStore.getState();
    const { settings, speakerNames, segments } = state;
    const meetingContext = meetingBriefText(state);
    if (!hasProviderKey(settings)) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", content: t("ask.missingKey") },
      ]);
      return;
    }

    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", content: "" }]);
    setShowThinking(true);
    setBusy(true);
    try {
      const { askAboutMeeting } = await import("../../lib/ai/ask");
      await askAboutMeeting({
        settings,
        segments,
        question: q,
        meetingContext,
        names: speakerNames,
        onDelta: (chunk) => {
          setMessages((m) => {
            const next = m.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });
          scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        },
        onReasoningDelta: (chunk) => {
          setMessages((m) => {
            const next = m.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + chunk };
            return next;
          });
          scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        },
      });
    } catch (err) {
      const { hostedLlmErrorCode } = await import("../../lib/ai/errors");
      const code = hostedLlmErrorCode(err, settings.provider);
      let content = t("ask.failed", { error: err instanceof Error ? err.message : String(err) });
      if (code === "credits") {
        content = t("ask.error.credits");
      } else if (code === "auth") {
        content = t("ask.error.auth");
      }
      setMessages((m) => {
        const next = m.slice();
        next[next.length - 1] = { id: crypto.randomUUID(), role: "assistant", content };
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-3">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 pt-16 text-center">
              <p className="text-xs text-muted-foreground">{t("ask.empty")}</p>
              <div className="flex flex-col items-stretch gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy}
                    onClick={() => ask(t(s)).catch((error) => log.error("ask: suggestion failed", { error: String(error) }))}
                    className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-foreground/90 transition-colors hover:bg-muted disabled:opacity-40"
                  >
                    {t(s)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m, i) => {
                if (m.role === "user") {
                  return (
                  <div
                    key={m.id}
                    className="select-text ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground"
                  >
                    {m.content}
                  </div>
                  );
                }

                let assistantBody = null;
                if (m.content) {
                  assistantBody = (
                    <div className="prose prose-invert prose-sm select-text max-w-none text-foreground prose-p:my-1.5 prose-pre:my-2 prose-pre:bg-neutral-900 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  );
                } else if (busy && i === messages.length - 1 && !m.reasoning) {
                  assistantBody = <p className="text-sm text-muted-foreground">…</p>;
                }

                return (
                  <div key={m.id} className="w-full">
                    {busy && i === messages.length - 1 && !m.content && m.reasoning ? (
                      <div className="mb-1">
                        <button
                          type="button"
                          onClick={() => setShowThinking((v) => !v)}
                          className="flex items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
                        >
                          <span className="animate-pulse">{t("ask.thinking")}</span>
                          {showThinking ? (
                            <ChevronUp className="size-3" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )}
                        </button>
                        {showThinking && (
                          <p className="select-text mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/60">
                            {m.reasoning}
                          </p>
                        )}
                      </div>
                    ) : null}
                    {assistantBody}
                  </div>
                );
              })}
              <div ref={scrollRef} />
            </div>
          )}
        </div>
      </ScrollArea>

      <form onSubmit={submit} className="border-t p-2.5">
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Don't hijack keys while an IME composition is active — Enter
                // commits the candidate, arrows navigate it, Tab picks it.
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(e);
                  return;
                }
                if (input) return;
                if (e.key === "Tab" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setInput(t(SUGGESTIONS[suggestionIdx]));
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggestionIdx(
                    (i) =>
                      (i + (e.key === "ArrowDown" ? 1 : SUGGESTIONS.length - 1)) %
                      SUGGESTIONS.length
                  );
                }
              }}
              rows={1}
              aria-label={t("ask.placeholder")}
              className="max-h-32 min-h-9 resize-none"
            />
            {!input && (
              <div
                key={suggestionIdx}
                className="pointer-events-none absolute inset-x-2.5 top-2 flex items-center gap-1.5 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-300"
              >
                <span className="truncate text-base text-muted-foreground/60 md:text-sm">
                  {t(SUGGESTIONS[suggestionIdx])}
                </span>
                <kbd className="shrink-0 rounded border px-1 font-sans text-[9px] text-muted-foreground/70">
                  Tab
                </kbd>
              </div>
            )}
          </div>
          <Button type="submit" size="icon" className="size-9 shrink-0" disabled={!input.trim() || busy}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">
          {t("ask.contextCount", { count: segmentCount })}
        </p>
      </form>
    </div>
  );
}
