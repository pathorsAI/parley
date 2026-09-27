import { ArrowRight, Check } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { loadHistoryEntry } from "../../lib/history/history";
import { loadSampleRecording } from "../../lib/onboarding/sample";
import {
  GETTING_STARTED_STEPS,
  dismissGettingStarted,
  gettingStartedProgress,
} from "../../lib/onboarding/gettingStarted";
import { modChordCap } from "../../lib/commands/format";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GettingStartedState, GettingStartedStep } from "../../lib/types";
import {
  TranscribingPulse,
  useTranscribingPulse,
  type TranscribingRunner,
} from "../onboarding/TranscribingPulse";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Open a saved recording on one of the two study pages. The tab is set first so
 *  the study screen mounts straight onto it. */
export async function openRecording(id: string, tab: "report" | "replay"): Promise<void> {
  useStore.getState().setStudyTab(tab);
  await loadHistoryEntry(id);
}

/**
 * Load the bundled sample into the library and open its report. Resolves to the
 * new entry id, or null (the loader has already toasted) when unavailable. Shared
 * by the checklist, Home's empty-recordings box and the setup wizard.
 *
 * `wait` wraps the load in the transcribing beat (see TranscribingPulse) so the
 * report — and its filing suggestion — appears after a moment of "work" instead
 * of already being there. Without one the sample opens as soon as it has loaded.
 */
export async function openSampleRecording(
  wait: TranscribingRunner = (work) => work(),
): Promise<string | null> {
  // The loader owns the failure toast; a null here has already been reported.
  const id = await wait(loadSampleRecording);
  if (!id) return null;
  await openRecording(id, "report");
  return id;
}

/**
 * The Home "getting started" checklist, demoted in v2 to an INDEX of the lap:
 * four rows that tick from the real product events (see
 * lib/onboarding/gettingStarted.ts) — never from a click here — and no per-row
 * buttons. The teaching happens on the study page, in the guide bar; this list
 * only says how far along the user is and has one way in: walk through the
 * sample (nothing recorded yet) or continue the lap where it was left.
 *
 * Rendered by HomeScreen only while `isGettingStartedVisible`; this component
 * assumes it should show.
 */
export function GettingStarted({
  state,
  lapEntryId,
  style,
}: Readonly<{
  state: GettingStartedState;
  /** The recording the lap runs on: the sample if it's in the library, else the
   *  most recent recording. Null when the library is empty. */
  lapEntryId: string | null;
  style?: React.CSSProperties;
}>) {
  const { t } = useI18n();
  const { done, total } = gettingStartedProgress(state);
  const pulse = useTranscribingPulse();

  const fail = (what: string) => (e: unknown) => {
    log.error(`home: getting started ${what} failed`, { error: String(e) });
    toast.error(t("home.gs.openFailed", { error: errText(e) }));
  };

  // Nothing to continue on (nothing recorded, or the library was emptied since):
  // the lap starts from the sample.
  const startFresh = !state.recorded || !lapEntryId;
  const go = () => {
    if (startFresh) void openSampleRecording(pulse.run).catch(fail("sample"));
    else void openRecording(lapEntryId, "report").catch(fail("open"));
  };

  const sub = (step: GettingStartedStep): string =>
    step === "replayed"
      ? t("home.gs.replayed.sub", { shortcut: modChordCap("F") })
      : t(`home.gs.${step}.sub` as TranslationKey);

  return (
    <section className="animate-fade-up flex flex-col" style={style} data-testid="getting-started">
      <div className="flex items-center gap-3 pb-1">
        <h2 className="text-sm font-semibold">{t("home.gs.title")}</h2>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="gs-progress">
          {t("home.gs.progress", { done, total })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {pulse.active ? (
            <TranscribingPulse />
          ) : (
            // The one way in. Text-weight blue: Home's filled "Start meeting"
            // sits right above, and two filled buttons would compete.
            <Button
              variant="ghost"
              size="sm"
              data-testid="gs-go"
              onClick={go}
              className="text-primary hover:bg-primary/10 hover:text-primary"
            >
              {startFresh ? t("home.gs.walkSample") : t("home.gs.continue")}
              {!startFresh && <ArrowRight data-icon="inline-end" />}
            </Button>
          )}
          <button
            type="button"
            onClick={dismissGettingStarted}
            className="cursor-pointer rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("home.gs.dismiss")}
          </button>
        </span>
      </div>
      <ol className="flex flex-col divide-y divide-border">
        {GETTING_STARTED_STEPS.map((step) => {
          const isDone = state[step];
          return (
            <li key={step} data-step={step} data-done={isDone} className="flex items-center gap-3 py-3">
              {isDone ? (
                <span
                  role="img"
                  aria-label={t("home.gs.done")}
                  className="grid size-4 shrink-0 place-items-center rounded-full bg-success-foreground text-background"
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : (
                <span className="size-4 shrink-0 rounded-[4px] border border-muted-foreground/40" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("text-sm", isDone && "text-muted-foreground")}>
                  {t(`home.gs.${step}.title` as TranslationKey)}
                </span>
                {!isDone && <span className="text-xs text-muted-foreground">{sub(step)}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
