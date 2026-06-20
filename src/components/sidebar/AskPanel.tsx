import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n, type TranslationKey } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
  const segmentCount = useStore((s) => s.segments.length);
  const scrollRef = useRef<HTMLDivElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void ask(input);
  }

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);

    const state = useStore.getState();
    const { settings, speakerNames, meetingContext, segments } = state;
    if (!hasProviderKey(settings)) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: t("ask.missingKey") },
      ]);
      return;
    }

    setMessages((m) => [...m, { role: "assistant", content: "" }]);
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
            next[next.length - 1] = {
              role: "assistant",
              content: next[next.length - 1].content + chunk,
            };
            return next;
          });
          scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        },
      });
    } catch (err) {
      setMessages((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: t("ask.failed", { error: err instanceof Error ? err.message : String(err) }),
        };
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
                    onClick={() => void ask(t(s))}
                    className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-foreground/90 transition-colors hover:bg-muted disabled:opacity-40"
                  >
                    {t(s)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="select-text ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground"
                  >
                    {m.content}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="prose prose-invert prose-sm select-text mr-auto max-w-[92%] rounded-lg bg-muted px-3 py-2 text-foreground prose-p:my-1.5 prose-pre:my-2 prose-pre:bg-neutral-900 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5"
                  >
                    {m.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    ) : busy && i === messages.length - 1 ? (
                      "…"
                    ) : null}
                  </div>
                )
              )}
              <div ref={scrollRef} />
            </div>
          )}
        </div>
      </ScrollArea>

      <form onSubmit={submit} className="border-t p-2.5">
        {messages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void ask(t(s))}
                className="rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                {t(s)}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(e);
              }
            }}
            rows={1}
            placeholder={t("ask.placeholder")}
            className="max-h-32 min-h-9 resize-none"
          />
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
