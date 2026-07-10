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

/** Rotating ask-bar suggestions (same catalog the old Ask pane used). */
const SUGGESTIONS = [
  "ask.suggestion.next",
  "ask.suggestion.agreed",
  "ask.suggestion.unanswered",
  "ask.suggestion.pushback",
  "ask.suggestion.summary",
] as const;

/** Empty-state illustration: a quiet stack of coach cards waiting to arrive. */
function FeedPlaceholder() {
  return (
    <svg viewBox="0 0 200 130" className="mx-auto h-28 w-44 text-muted-foreground/40" aria-hidden>
      {/* back cards, tilted like a settled stack */}
      <g transform="rotate(-4 100 78)">
        <rect x="38" y="62" width="124" height="30" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
      </g>
      <g transform="rotate(2 100 62)">
        <rect x="34" y="44" width="132" height="30" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".7" />
        <line x1="46" y1="55" x2="112" y2="55" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".5" />
        <line x1="46" y1="63" x2="88" y2="63" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".3" />
      </g>
      {/* front card with the coach's accent dot */}
      <rect x="30" y="22" width="140" height="32" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="45" cy="38" r="5" className="text-emerald-500/70" fill="currentColor" />
      <line x1="58" y1="33" x2="140" y2="33" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".6" />
      <line x1="58" y1="42" x2="118" y2="42" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".35" />
      {/* the whistle: your coach, standing by */}
      <g className="text-emerald-500/60" transform="translate(148 96) rotate(-18)">
        <circle cx="0" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="0" cy="10" r="2.4" fill="currentColor" />
        <path d="M6 3 L26 -4 L27.5 1.5 L10 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </g>
      {/* faint incoming-signal dashes */}
      <line x1="96" y1="6" x2="104" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".3" />
      <line x1="82" y1="12" x2="88" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".2" />
      <line x1="112" y1="12" x2="118" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".2" />
    </svg>
  );
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
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = askCards.some((c) => c.busy);
  const suggestion = t(SUGGESTIONS[suggestionIdx]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [findings.length, askCards]);

  // Rotate the ghost suggestion while the input is empty.
  useEffect(() => {
    if (input) return;
    const id = setInterval(() => setSuggestionIdx((i) => (i + 1) % SUGGESTIONS.length), 4000);
    return () => clearInterval(id);
  }, [input]);

  // Tab / → completes the ghost suggestion into the input; ↑ / ↓ cycles it.
  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (input) return;
    if (e.key === "Tab" || e.key === "ArrowRight") {
      e.preventDefault();
      setInput(suggestion);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestionIdx((i) => (i + 1) % SUGGESTIONS.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestionIdx((i) => (i - 1 + SUGGESTIONS.length) % SUGGESTIONS.length);
    }
  }

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
            <div className="flex flex-col items-center gap-3 px-1 py-10">
              <FeedPlaceholder />
              <p className="max-w-56 text-center text-sm text-muted-foreground">{t("feed.empty")}</p>
            </div>
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
        <div className="relative min-w-0 flex-1">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={suggestion}
            className="h-8 pr-12 text-sm"
            disabled={busy}
          />
          {!input && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
              Tab ↹
            </kbd>
          )}
        </div>
        <Button type="submit" size="icon" className="h-8 w-8 shrink-0" disabled={busy || !input.trim()}>
          <ArrowUp className="size-4" />
        </Button>
      </form>
    </div>
  );
}
