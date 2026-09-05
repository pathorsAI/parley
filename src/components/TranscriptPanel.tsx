import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useStore, speakerKey } from "../lib/store";
import { speakerBadgeClass } from "../lib/speakerColors";
import { useStickToBottom } from "../lib/useStickToBottom";
import { useI18n } from "../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";

export function TranscriptPanel() {
  const { t } = useI18n();
  const segments = useStore((s) => s.segments);
  const status = useStore((s) => s.meetingStatus);
  const names = useStore((s) => s.speakerNames);
  const highlightMs = useStore((s) => s.highlightMs);
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const runRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);

  // Time-ordered, non-empty runs across both audio sources.
  const runs = useMemo(
    () =>
      segments
        .filter((s) => s.text.trim())
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    [segments]
  );

  const { viewportRef, following, scrollToBottom, programmaticScroll } = useStickToBottom([runs]);

  // Jump-to-timestamp from the debrief: scroll to the run covering that time
  // (or the nearest) and flash it. It goes through the hook so the arriving
  // segments don't immediately drag the view off the moment we jumped to.
  useEffect(() => {
    if (highlightMs == null || runs.length === 0) return;
    const target =
      runs.find((r) => highlightMs >= r.startMs && highlightMs <= r.endMs) ??
      runs.reduce((best, r) =>
        Math.abs(r.startMs - highlightMs) < Math.abs(best.startMs - highlightMs) ? r : best
      );
    programmaticScroll(() =>
      runRefs.current[target.id]?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
    setFlashId(target.id);
    setHighlightMs(null); // consume the signal
    const timer = setTimeout(() => setFlashId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightMs, runs, setHighlightMs, programmaticScroll]);

  function label(seg: (typeof runs)[number]) {
    const customName = names[speakerKey(seg)];
    if (customName) return customName;
    if (seg.source === "me") {
      return (seg.speaker || 1) <= 1 ? t("speaker.you") : t("speaker.speaker", { number: seg.speaker });
    }
    return seg.speaker > 0 ? t("speaker.remote", { number: seg.speaker }) : t("speaker.them");
  }

  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {status === "recording" || status === "paused"
          ? t("meeting.listening")
          : t("meeting.startPrompt")}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <ScrollArea className="h-full" viewportRef={viewportRef}>
        <div className="select-text mx-auto max-w-3xl px-5 py-5 text-sm leading-8">
          {runs.map((seg, i) => {
            const showBadge = i === 0 || speakerKey(seg) !== speakerKey(runs[i - 1]);
            return (
              <Fragment key={seg.id}>
                {showBadge && (
                  <span
                    className={`mx-0.5 inline-flex translate-y-[-1px] items-center rounded-md px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide ring-1 ${speakerBadgeClass(
                      seg
                    )}`}
                  >
                    {label(seg)}
                  </span>
                )}{" "}
                <span
                  ref={(el) => {
                    runRefs.current[seg.id] = el;
                  }}
                  className={`${seg.isFinal ? "text-foreground/90" : "text-muted-foreground"} ${
                    flashId === seg.id ? "rounded bg-amber-400/30" : ""
                  }`}
                >
                  {seg.text}
                  {!seg.isFinal && <span className="animate-pulse">▍</span>}
                </span>{" "}
              </Fragment>
            );
          })}
        </div>
      </ScrollArea>

      {/* The way back to the tail, one click instead of a long drag. */}
      {!following && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/80 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          <ArrowDown className="size-3" />
          {t("transcript.jumpToLatest")}
        </button>
      )}
    </div>
  );
}
