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
    <svg viewBox="0 0 220 140" className="mx-auto h-28 w-44 text-muted-foreground/40" aria-hidden>
      {/* faint incoming-signal dashes, well above the stack */}
      <line x1="82" y1="8" x2="94" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".25" />
      <line x1="104" y1="8" x2="118" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".35" />
      <line x1="128" y1="8" x2="136" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".25" />
      {/* front card with the coach's accent dot */}
      <rect x="40" y="22" width="120" height="28" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="54" cy="36" r="4.5" className="text-emerald-500/70" fill="currentColor" />
      <line x1="64" y1="31" x2="140" y2="31" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".55" />
      <line x1="64" y1="41" x2="120" y2="41" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".3" />
      {/* middle card, gently tilted */}
      <g transform="rotate(-2 104 71)">
        <rect x="48" y="60" width="112" height="22" rx="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
        <line x1="60" y1="71" x2="126" y2="71" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".35" />
      </g>
      {/* back card, settling out of view */}
      <g transform="rotate(2 100 102)">
        <rect x="52" y="94" width="96" height="16" rx="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      </g>
      {/* the whistle: your coach, standing by (bottom-right, clear of the stack) */}
      <g className="text-emerald-500/70" transform="translate(188 118) rotate(-15)">
        <circle cx="0" cy="0" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="0" cy="0" r="2.4" fill="currentColor" />
        <path d="M6 -6 L26 -13 L27.8 -7.6 L9 -1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </g>
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
    if (!hasProviderKey(state.settings, "realtime")) {
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
  const recording = useStore((s) => s.meetingStatus === "recording");

  // The header upload button's other replacement: import from the idle feed.
  async function importRecording() {
    const { settings, openIngestWizard } = useStore.getState();
    try {
      const { pickRecordingFile } = await import("../../lib/replay/ingest");
      const audioPath = await pickRecordingFile(settings);
      if (audioPath) openIngestWizard(audioPath);
    } catch (e) {
      log.error("feed: import failed", { error: String(e) });
    }
  }

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
              {!recording && (
                <button
                  type="button"
                  onClick={() => void importRecording()}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {t("feed.import")}
                </button>
              )}
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
