import { Fragment, useEffect, useMemo, useRef } from "react";
import { useStore, speakerKey, speakerLabel } from "../lib/store";
import { speakerBadgeClass } from "../lib/speakerColors";
import { ScrollArea } from "@/components/ui/scroll-area";

export function TranscriptPanel() {
  const segments = useStore((s) => s.segments);
  const status = useStore((s) => s.meetingStatus);
  const names = useStore((s) => s.speakerNames);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {status === "recording"
          ? "Listening…"
          : "Press “Start meeting” to begin transcribing."}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl px-5 py-5 text-sm leading-8">
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
                  {speakerLabel(seg, names)}
                </span>
              )}{" "}
              <span className={seg.isFinal ? "text-foreground/90" : "text-muted-foreground"}>
                {seg.text}
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
