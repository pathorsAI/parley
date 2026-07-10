import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, meetingBriefText } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { runAnalysis } from "../../lib/analysis/engine";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { FindingRow } from "../analysis/FindingRow";
import { openSolution, selectAndSeek } from "../analysis/useAnalysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AskCard {
  id: string;
  question: string;
  answer: string;
  busy: boolean;
}

/**
 * The LIVE center pane: one chronological coach stream — evaluation findings
 * (each drills into "how to reply") and inline Ask answers — with a single ask
 * input bar at the bottom. Replaces the tabbed Ask/TODO WorkPanel: the coach
 * has one mouth, and the center of the screen belongs to it. (Total-design §03:
 * the feed carries EVENTS; accumulated STATE lives in the IntelligenceBoard.)
 */
export function CoachFeed({ onSeek }: Readonly<{ onSeek: (ms: number) => void }>) {
  const { t } = useI18n();
  const findings = useStore((s) => s.findings);
  const selectedId = useStore((s) => s.selectedFindingId);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const running = analysisStatus === "running";

  const [askCards, setAskCards] = useState<AskCard[]>([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = askCards.some((c) => c.busy);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [findings.length, askCards]);

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setInput("");
    const id = crypto.randomUUID();
    setAskCards((c) => [...c, { id, question: q, answer: "", busy: true }]);
    const state = useStore.getState();
    if (!hasProviderKey(state.settings)) {
      setAskCards((c) =>
        c.map((x) => (x.id === id ? { ...x, answer: t("ask.missingKey"), busy: false } : x))
      );
      return;
    }
    try {
      const { askAboutMeeting } = await import("../../lib/ai/ask");
      await askAboutMeeting({
        settings: state.settings,
        segments: state.segments,
        question: q,
        meetingContext: meetingBriefText(state),
        names: state.speakerNames,
        onDelta: (chunk) => {
          setAskCards((c) =>
            c.map((x) => (x.id === id ? { ...x, answer: x.answer + chunk } : x))
          );
        },
      });
    } catch (e) {
      log.error("feed: ask failed", { error: String(e) });
      setAskCards((c) =>
        c.map((x) => (x.id === id ? { ...x, answer: String(e), busy: false } : x))
      );
    } finally {
      setAskCards((c) => c.map((x) => (x.id === id ? { ...x, busy: false } : x)));
    }
  }

  const empty = findings.length === 0 && askCards.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Feed header: the analyze action (the feed's manual refresh). */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("feed.title")}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={running}
          onClick={() =>
            runAnalysis({ mode: "live" }).catch((e) =>
              log.error("analysis: live run failed", { error: String(e) })
            )
          }
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {t("feed.analyze")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-2">
          {empty && (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">{t("feed.empty")}</p>
          )}
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              event={f}
              selected={f.id === selectedId}
              onSelect={(ev) => selectAndSeek(ev, onSeek)}
              onOpenSolution={(ev) => openSolution(ev, onSeek)}
            />
          ))}
          {askCards.map((c) => (
            <div key={c.id} className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">💬 {c.question}</p>
              {c.answer ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.answer}</ReactMarkdown>
                </div>
              ) : (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* The ask bar — Ask demoted from a resident chat pane to one input line. */}
      <form
        className="flex shrink-0 gap-1.5 border-t px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("feed.askPlaceholder")}
          className="h-8 text-sm"
          disabled={busy}
        />
        <Button type="submit" size="icon" className="h-8 w-8 shrink-0" disabled={busy || !input.trim()}>
          <ArrowUp className="size-4" />
        </Button>
      </form>
    </div>
  );
}
