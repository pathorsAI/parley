import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore, speakerKey } from "../lib/store";
import { speakerBadgeClass } from "../lib/speakerColors";
import { useI18n } from "../i18n";
import { ScrollArea } from "@/components/ui/scroll-area";

export function TranscriptPanel() {
  const { t } = useI18n();
  const segments = useStore((s) => s.segments);
  const status = useStore((s) => s.meetingStatus);
  const names = useStore((s) => s.speakerNames);
  const highlightMs = useStore((s) => s.highlightMs);
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const bottomRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runs]);

  // Jump-to-timestamp from the debrief: scroll to the run covering that time
  // (or the nearest) and flash it.
  useEffect(() => {
    if (highlightMs == null || runs.length === 0) return;
    const target =
      runs.find((r) => highlightMs >= r.startMs && highlightMs <= r.endMs) ??
      runs.reduce((best, r) =>
        Math.abs(r.startMs - highlightMs) < Math.abs(best.startMs - highlightMs) ? r : best
      );
    runRefs.current[target.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(target.id);
    setHighlightMs(null); // consume the signal
    const timer = setTimeout(() => setFlashId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightMs, runs, setHighlightMs]);

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
    <ScrollArea className="h-full">
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
                {/* Translated meeting: show what the counterpart actually heard
                    (the Gemini voice output) as a quieter inline echo. */}
                {seg.translation && (
                  <span className="mx-1 text-[0.9em] italic text-emerald-700/70 dark:text-emerald-400/70">
                    → {seg.translation}
                  </span>
                )}
                {!seg.isFinal && <span className="animate-pulse">▍</span>}
              </span>{" "}
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
