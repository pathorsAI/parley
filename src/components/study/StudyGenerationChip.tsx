import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import {
  AlertTriangle,
  Check,
  Clock,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  reanalyzeAll,
  regenerateArtifact,
  useStudyPipeline,
  type StudyArtifactDisplay,
  type StudyArtifactKey,
  type StudyArtifactState,
} from "../../lib/analysis/studyPipeline";
import { useI18n, type TranslationKey } from "../../i18n";
import { LANGUAGE_OPTIONS } from "../../i18n/messages";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { Flag } from "@/components/ui/flag";
import { MeetingContextDialog } from "../MeetingContextDialog";
import { cn } from "@/lib/utils";

const ARTIFACT_LABEL: Record<StudyArtifactKey, TranslationKey> = {
  findings: "timeline.title",
  actions: "actionItems.title",
  brief: "study.brief",
  delivery: "study.delivery",
  intel: "study.intel",
};

/** One visual treatment per artifact state — data, so the row renders once. */
const STATUS_UI: Record<
  StudyArtifactDisplay | "off",
  { icon?: LucideIcon; spin?: boolean; className: string; label: TranslationKey }
> = {
  queued: { icon: Clock, className: "text-amber-600 dark:text-amber-400", label: "studyGen.status.queued" },
  running: { icon: Loader2, spin: true, className: "text-violet-600 dark:text-violet-400", label: "studyGen.status.running" },
  done: { icon: Check, className: "text-muted-foreground", label: "common.done" },
  error: { icon: AlertTriangle, className: "text-red-600 dark:text-red-400", label: "studyGen.status.error" },
  idle: { className: "text-muted-foreground", label: "studyGen.status.idle" },
  // Not applicable (intel without a typed template / nothing to extract).
  off: { className: "text-muted-foreground", label: "studyGen.status.noTemplate" },
};

/**
 * THE analysis surface for a loaded recording, next to the study tabs in the
 * titlebar: a chip that always reflects the pipeline's real state (generating
 * n/total, done, failed, or key missing), and a dropdown listing every study
 * artifact with its status, a per-artifact regenerate, and "regenerate all"
 * (which first opens the meeting-context dialog as its confirm step, since it
 * overwrites every output and spends a fresh deep pass). Replaces the buttons
 * that used to be scattered across the replay player bar and report sections.
 *
 * Regeneration is INVALIDATION (regenerateArtifact/reanalyzeAll): this
 * component never talks to the runners — the pipeline owns the topology.
 */
export function StudyGenerationChip() {
  const { t, language } = useI18n();
  const pipeline = useStudyPipeline();
  // Confirm-dialog for "regenerate all": adjust context, then run.
  const [confirming, setConfirming] = useState(false);

  if (!pipeline.hasTranscript) return null;

  const anyRunning = pipeline.artifacts.some((a) => a.display === "running");

  function confirmRegenAll() {
    setConfirming(false);
    reanalyzeAll().catch((error) =>
      log.error("study: reanalyze all failed", { error: String(error) }),
    );
  }

  const outputOption = LANGUAGE_OPTIONS.find((o) => o.value === language);
  const outputLanguage = outputOption?.nativeLabel ?? language;

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={chipClass(pipeline)} title={chipTitle(pipeline, t)}>
            <ChipContent pipeline={pipeline} t={t} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="center"
            sideOffset={8}
            className="z-[80] w-72 rounded-lg border bg-popover p-0 text-popover-foreground shadow-md"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("studyGen.panel.title")}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                {t("studyGen.language")}：
                <Flag code={outputOption?.flag} className="size-3" />
                {outputLanguage}
              </span>
            </div>

            {pipeline.artifacts.map((a) => (
              <ArtifactRow
                key={a.key}
                artifact={a}
                label={t(ARTIFACT_LABEL[a.key])}
                t={t}
                // One pass at a time: regenerating anything while another output
                // streams would race the chained pipeline (and double-spend).
                disabled={!pipeline.hasDeepKey || anyRunning || !a.applicable}
                onRegen={() => regenerateArtifact(a.key)}
              />
            ))}

            <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
              <DropdownMenu.Item
                disabled={!pipeline.hasDeepKey || anyRunning}
                onSelect={() => setConfirming(true)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium outline-none",
                  "data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                )}
              >
                <Sparkles className="size-3.5" />
                {t("studyGen.regenAll")}
              </DropdownMenu.Item>
              {!pipeline.hasDeepKey && (
                <span className="text-[10px] text-muted-foreground">{t("analyze.noKey")}</span>
              )}
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Regenerate-all confirm: the context field doubles as the "are you sure"
          step — it overwrites every output, so it never fires on one click. */}
      {confirming && (
        <MeetingContextDialog
          onClose={() => setConfirming(false)}
          closeLabel={t("common.cancel")}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {t("common.cancel")}
              </button>
              <Button size="sm" className="h-8 gap-1.5" onClick={confirmRegenAll}>
                <Sparkles className="size-3.5" />
                {t("studyGen.regenAll.confirm")}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-xs text-muted-foreground">{t("studyGen.regenAll.hint")}</p>
        </MeetingContextDialog>
      )}
    </>
  );
}

type TFn = ReturnType<typeof useI18n>["t"];
type Pipeline = ReturnType<typeof useStudyPipeline>;

function chipClass(p: Pipeline): string {
  return cn(
    "flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
    !p.hasDeepKey
      ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : p.active
        ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400"
        : p.errors > 0
          ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
  );
}

function chipTitle(p: Pipeline, t: TFn): string {
  if (!p.hasDeepKey) return t("analyze.noKey");
  return t("studyGen.panel.title");
}

function ChipContent({ pipeline: p, t }: Readonly<{ pipeline: Pipeline; t: TFn }>) {
  if (!p.hasDeepKey) {
    return (
      <>
        <KeyRound className="size-3" />
        {t("studyGen.chip.noKey")}
      </>
    );
  }
  if (p.active) {
    return (
      <>
        <Loader2 className="size-3 animate-spin" />
        {t("studyGen.chip.running", { done: p.done, total: p.total })}
      </>
    );
  }
  if (p.errors > 0) {
    return (
      <>
        <AlertTriangle className="size-3" />
        {t("studyGen.chip.failed", { count: p.errors })}
      </>
    );
  }
  if (p.done === p.total && p.total > 0) {
    return (
      <>
        <Check className="size-3" />
        {t("studyGen.chip.done")}
      </>
    );
  }
  return (
    <>
      <Sparkles className="size-3" />
      {t("studyGen.chip.idle")}
    </>
  );
}

function ArtifactRow({
  artifact,
  label,
  t,
  disabled,
  onRegen,
}: Readonly<{
  artifact: StudyArtifactState;
  label: string;
  t: TFn;
  disabled: boolean;
  onRegen: () => void;
}>) {
  const ui = STATUS_UI[artifact.applicable ? artifact.display : "off"];
  const Icon = ui.icon;
  const busy = artifact.display === "running" || artifact.display === "queued";
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className={cn("flex items-center gap-1 text-[11px]", ui.className)}>
        {Icon && <Icon className={cn("size-3", ui.spin && "animate-spin")} />}
        {t(ui.label)}
      </span>
      <DropdownMenu.Item
        disabled={disabled || busy}
        onSelect={(e) => {
          // Keep the panel open so the row flips to "generating" in place.
          e.preventDefault();
          onRegen();
        }}
        title={t("studyGen.regen")}
        className={cn(
          "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded outline-none",
          "text-muted-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground",
          "data-[disabled]:pointer-events-none data-[disabled]:opacity-30",
        )}
      >
        <RefreshCw className="size-3" />
      </DropdownMenu.Item>
    </div>
  );
}
