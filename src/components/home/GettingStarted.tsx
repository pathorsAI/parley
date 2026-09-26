import type { ReactNode } from "react";
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Open a saved recording on one of the two study pages. The tab is set first so
 *  the study screen mounts straight onto it. */
async function openRecording(id: string, tab: "report" | "replay"): Promise<void> {
  useStore.getState().setStudyTab(tab);
  await loadHistoryEntry(id);
}

/**
 * Load the bundled sample into the library and open its report. Resolves to the
 * new entry id, or null (the loader has already toasted) when unavailable. Shared
 * by the checklist and Home's empty-recordings box.
 */
export async function openSampleRecording(): Promise<string | null> {
  // The loader owns the failure toast; a null here has already been reported.
  const id = await loadSampleRecording();
  if (!id) return null;
  await openRecording(id, "report");
  return id;
}

/** Scroll a section of the (just-opened) report into view once it has rendered.
 *  A few frames of patience, then give up quietly — harmless when absent. */
function scrollToWhenRendered(elementId: string, framesLeft = 20): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(elementId);
    if (el) el.scrollIntoView({ behavior: "smooth" });
    else if (framesLeft > 0) scrollToWhenRendered(elementId, framesLeft - 1);
  });
}

/**
 * The Home "getting started" checklist: four things to do once, each ticked by
 * the real product event (see lib/onboarding/gettingStarted.ts) — never by a
 * click here. The CTAs only take the user to where the event happens.
 *
 * Rendered by HomeScreen only while `isGettingStartedVisible`; this component
 * assumes it should show.
 */
export function GettingStarted({
  state,
  latestId,
  style,
}: Readonly<{
  state: GettingStartedState;
  /** The most recent personal recording, which the CTAs open. */
  latestId: string | null;
  style?: React.CSSProperties;
}>) {
  const { t } = useI18n();
  const { done, total } = gettingStartedProgress(state);

  const fail = (what: string) => (e: unknown) => {
    log.error(`home: getting started ${what} failed`, { error: String(e) });
    toast.error(t("home.gs.openFailed", { error: errText(e) }));
  };

  const openSample = () => {
    void openSampleRecording().catch(fail("sample"));
  };

  /** Open the most recent recording on `tab` — or, with none yet, the sample. */
  const openLatest = (tab: "report" | "replay", then?: () => void) => {
    void (async () => {
      if (latestId) {
        await openRecording(latestId, tab);
      } else {
        const id = await openSampleRecording();
        if (!id) return;
        if (tab !== "report") useStore.getState().setStudyTab(tab);
      }
      then?.();
    })().catch(fail("open"));
  };

  const ctas: Record<GettingStartedStep, ReactNode> = {
    // Home's own primary "Start meeting" button sits right above the list, so
    // this row only offers the sample — two filled buttons would compete.
    recorded: (
      <Button variant="ghost" size="sm" onClick={openSample}>
        {t("home.gs.useSample")}
      </Button>
    ),
    filed: <StepLink onClick={() => openLatest("report")}>{t("home.gs.filed.cta")}</StepLink>,
    replayed: <StepLink onClick={() => openLatest("replay")}>{t("home.gs.replayed.cta")}</StepLink>,
    handedOff: (
      <StepLink onClick={() => openLatest("report", () => scrollToWhenRendered("handoff"))}>
        {t("home.gs.handedOff.cta")}
      </StepLink>
    ),
  };

  const sub = (step: GettingStartedStep): string =>
    step === "replayed"
      ? t("home.gs.replayed.sub", { shortcut: modChordCap("F") })
      : t(`home.gs.${step}.sub` as TranslationKey);

  return (
    <section className="animate-fade-up flex flex-col" style={style} data-testid="getting-started">
      <div className="flex items-center gap-3 pb-1">
        <h2 className="text-sm font-semibold">{t("home.gs.title")}</h2>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" data-testid="gs-progress">
          {t("home.gs.progress", { done, total })}
        </span>
        <button
          type="button"
          onClick={dismissGettingStarted}
          className="cursor-pointer rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("home.gs.dismiss")}
        </button>
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
              {!isDone && <span className="flex shrink-0 items-center gap-1">{ctas[step]}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A quiet text CTA — blue is reserved for the one filled primary button. */
function StepLink({ onClick, children }: Readonly<{ onClick: () => void; children: ReactNode }>) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="text-muted-foreground">
      {children}
      <ArrowRight data-icon="inline-end" />
    </Button>
  );
}
