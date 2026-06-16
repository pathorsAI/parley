import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AskPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const segmentCount = useStore((s) => s.segments.length);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);

    const { settings, segments, speakerNames } = useStore.getState();
    if (!hasProviderKey(settings)) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "尚未設定 LLM API 金鑰。請到設定（右上角 ⚙）填入 Claude 或 OpenRouter 金鑰後再試。" },
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
        meetingContext: settings.meetingContext,
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
          content: `（回答失敗：${err instanceof Error ? err.message : String(err)}）`,
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
            <p className="px-4 pt-10 text-center text-xs text-muted-foreground">
              問任何關於這場會議的問題，例如「對方剛剛同意了什麼？」「我還有哪些沒問？」
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground"
                  >
                    {m.content}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="prose prose-invert prose-sm mr-auto max-w-[92%] rounded-lg bg-muted px-3 py-2 text-foreground prose-p:my-1.5 prose-pre:my-2 prose-pre:bg-neutral-900 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5"
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
            placeholder="Ask about the meeting…"
            className="max-h-32 min-h-9 resize-none"
          />
          <Button type="submit" size="icon" className="size-9 shrink-0" disabled={!input.trim() || busy}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">
          {segmentCount} segments in context
        </p>
      </form>
    </div>
  );
}
