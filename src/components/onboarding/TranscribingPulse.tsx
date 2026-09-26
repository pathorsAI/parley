import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";

/** How long the sample "transcribes" before it opens. */
export const TRANSCRIBING_MS = 1500;

/** Runs `work` behind the transcribing beat; resolves with its result. */
export type TranscribingRunner = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * The beat between pressing "walk through the sample" and the recording
 * opening. The sample loads in well under a second, so without it the report
 * appears already named and filed — and the filing suggestion reads as
 * furniture instead of something Parley just did. The pause is the product's
 * real sequence in miniature: transcribe, THEN suggest.
 *
 * `run(work)` starts `work` at once and resolves when BOTH it has settled and
 * {@link TRANSCRIBING_MS} has passed; `active` is true in between, for the
 * caller to swap the pressed button for {@link TranscribingPulse}. A second
 * press while active joins the first run rather than starting another.
 */
export function useTranscribingPulse(): { active: boolean; run: TranscribingRunner } {
  const [active, setActive] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    if (inFlight.current) return inFlight.current as Promise<T>;
    setActive(true);
    const wait = new Promise<void>((resolve) => setTimeout(resolve, TRANSCRIBING_MS));
    const p = Promise.all([work(), wait])
      .then(([result]) => result)
      .finally(() => {
        inFlight.current = null;
        // The wizard closes itself right after; don't set state on the way out.
        if (mounted.current) setActive(false);
      });
    inFlight.current = p;
    return p;
  }, []);

  return { active, run };
}

/**
 * A slim determinate bar with "Transcribing…" beside it, sized to sit where
 * the pressed button was. It fills over {@link TRANSCRIBING_MS}; blue because
 * it is the thing happening now.
 */
export function TranscribingPulse({ className }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  // Start empty, then fill on the next frame so the width transition runs.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setFilled(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <span
      role="status"
      data-testid="transcribing"
      className={cn("inline-flex h-8 min-w-40 items-center gap-2.5 text-xs text-muted-foreground", className)}
    >
      <span className="relative h-1 w-24 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary ease-out motion-reduce:transition-none"
          style={{ width: filled ? "100%" : "4%", transition: `width ${TRANSCRIBING_MS}ms` }}
        />
      </span>
      {t("onboarding.transcribing")}
    </span>
  );
}
