import { useEffect, useState } from "react";
import { AlertTriangle, Check, Cpu, Download, Loader2, RotateCcw, Trash2, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import {
  DEFAULT_LOCAL_STT_MODEL,
  autoLocalModelChoice,
  downloadGate,
  downloadPercent,
  formatModelSize,
  isLocalBusy,
  localModelLabel,
  presentAccel,
  presentFit,
  presentLoad,
  sortLocalModels,
  type LocalSttHardware,
  type LocalSttModel,
} from "../lib/transcription/localModels";
import type { LocalSttModelsState } from "../lib/transcription/useLocalSttModels";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Model picker for the on-device ("local") STT provider, shared by Settings ›
 * Transcription and onboarding. Choose first, download second: selecting a card
 * only sets `localSttModel`; the download is always an explicit click on the
 * callout below the list, and nothing local can start until it finishes (the
 * gates live in lib/transcription/localModels.ts). The caller owns the
 * `useLocalSttModels` state so onboarding can gate its Next button on it too.
 *
 * Hardware fit (docs/design/local-stt.md › Hardware): a line above the list says
 * what decoding runs on (the GPU, or "CPU only" and why); every card always
 * says how heavy its model is to run ("Light load · about 1 GB RAM") and, with
 * hardware info, how well it suits this machine; the backend's recommendation
 * is tagged, a full disk disables Download, too little RAM turns Download into
 * a two-step confirm, and "may be slow" is a note that blocks nothing. With no
 * hardware info the fit parts are simply absent. A user who never picked a model
 * (`chosen` false) is moved to the recommended one via `onAutoSelect`.
 */
export function LocalSttModelPicker({
  value,
  onChange,
  local,
  chosen = true,
  onAutoSelect,
}: Readonly<{
  value: string;
  /** An explicit pick (a click on a card). */
  onChange: (modelId: string) => void;
  local: LocalSttModelsState;
  /** The user has picked a model before; the recommendation never overrides it. */
  chosen?: boolean;
  /** Apply the recommended default (not an explicit pick). */
  onAutoSelect?: (modelId: string) => void;
}>) {
  const { t, language } = useI18n();
  const { models, loadError, hardware } = local;

  const auto = onAutoSelect
    ? autoLocalModelChoice({ current: value, chosen, models, hardware, language })
    : null;
  useEffect(() => {
    if (auto && onAutoSelect) {
      log.info("local-stt: default follows the hardware recommendation", { model: auto });
      onAutoSelect(auto);
    }
  }, [auto, onAutoSelect]);

  if (!models) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {loadError ? t("localStt.loadFailed", { error: loadError }) : t("localStt.loading")}
      </p>
    );
  }
  if (models.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{t("localStt.empty")}</p>;
  }

  const selected = models.find((m) => m.id === value) ?? null;

  return (
    <div className="flex flex-col gap-2.5">
      <AccelLine hardware={hardware} />
      <div role="radiogroup" aria-label={t("localStt.picker.label")} className="flex flex-col gap-1.5">
        {sortLocalModels(models).map((m) => (
          <ModelCard key={m.id} model={m} selected={m.id === value} local={local} onSelect={() => onChange(m.id)} />
        ))}
      </div>
      {selected && <SelectedModelActions key={selected.id} model={selected} local={local} />}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("localStt.note")}</p>
    </div>
  );
}

/** What decoding runs on: "GPU acceleration: <name>" or "CPU only" with the
 *  reason. Absent without hardware info. */
function AccelLine({ hardware }: Readonly<{ hardware: LocalSttHardware | null }>) {
  const { t } = useI18n();
  const accel = presentAccel(hardware, t);
  if (!accel) return null;
  const Icon = accel.tone === "gpu" ? Zap : Cpu;
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <Icon className={`mt-px size-3.5 shrink-0 ${accel.tone === "gpu" ? "text-primary" : ""}`} aria-hidden />
      <span>{t(accel.text.key, accel.text.vars)}</span>
    </p>
  );
}

function ModelCard({
  model,
  selected,
  local,
  onSelect,
}: Readonly<{ model: LocalSttModel; selected: boolean; local: LocalSttModelsState; onSelect: () => void }>) {
  const { t } = useI18n();
  const { name, description } = localModelLabel(t, model.id);
  const fit = presentFit(model, local.hardware, t);
  const load = presentLoad(model, local.hardware);
  // With hardware info the tag is "recommended for this computer"; without it,
  // the catalog default keeps its plain "recommended".
  const recommendedTag = local.hardware
    ? model.id === local.hardware.recommendedId && "localStt.recommendedHere"
    : model.id === DEFAULT_LOCAL_STT_MODEL && "localStt.recommended";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected ? "border-primary bg-primary/10" : "hover:bg-muted/50"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-primary" : "border-muted-foreground/50"
        }`}
      >
        {selected && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {name}
          {recommendedTag && (
            <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-normal text-primary">
              {t(recommendedTag)}
            </span>
          )}
          {fit && <Badge tone={fit.tone}>{t(fit.badge)}</Badge>}
        </span>
        {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
        {load.length > 0 && (
          <span className="text-[11px] text-muted-foreground/80">
            {load.map((part) => t(part.key, part.vars)).join(" · ")}
          </span>
        )}
        {fit?.reason && (
          <span className={`text-[11px] ${fit.tone === "danger" ? "text-danger-foreground" : "text-warning-foreground"}`}>
            {t(fit.reason.key, fit.reason.vars)}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[11px] tabular-nums text-muted-foreground">{formatModelSize(model.sizeBytes)}</span>
        <StateBadge model={model} local={local} />
      </span>
    </button>
  );
}

function StateBadge({ model, local }: Readonly<{ model: LocalSttModel; local: LocalSttModelsState }>) {
  const { t } = useI18n();
  const d = local.downloads[model.id];
  if (d?.status === "verifying") {
    return <Badge tone="info">{t("localStt.status.verifying")}</Badge>;
  }
  if (isLocalBusy(local.models, local.downloads, model.id)) {
    const percent = d?.status === "downloading" ? downloadPercent(d.received, d.total) : 0;
    return <Badge tone="info">{t("localStt.status.downloading", { percent })}</Badge>;
  }
  return model.installed ? (
    <Badge tone="success">{t("localStt.status.installed")}</Badge>
  ) : (
    <Badge tone="muted">{t("localStt.status.missing")}</Badge>
  );
}

function Badge({
  tone,
  children,
}: Readonly<{ tone: "success" | "info" | "muted" | "warning" | "danger"; children: React.ReactNode }>) {
  const cls = {
    success: "bg-success text-success-foreground",
    info: "bg-info text-info-foreground",
    muted: "bg-muted text-muted-foreground",
    warning: "bg-warning text-warning-foreground",
    danger: "bg-danger text-danger-foreground",
  }[tone];
  return <span className={`rounded px-1.5 py-px text-[10px] tabular-nums ${cls}`}>{children}</span>;
}

/** "May be slow": an amber note under the selected model that blocks nothing. */
function SlowNote({ model, local }: Readonly<{ model: LocalSttModel; local: LocalSttModelsState }>) {
  const { t } = useI18n();
  if (model.fit?.level !== "slow") return null;
  const fit = presentFit(model, local.hardware, t);
  return (
    <p className="rounded-md border border-warning-border bg-warning px-3 py-2 text-[11px] leading-relaxed text-warning-foreground">
      {t("localStt.fit.slowNote")}
      {fit?.reason && <> {t(fit.reason.key, fit.reason.vars)}</>}
    </p>
  );
}

/** The download / progress / retry / delete area for the selected model. Keyed
 *  by model id by its caller, so a half-finished "Download anyway" confirm
 *  never carries over to another model. */
function SelectedModelActions({ model, local }: Readonly<{ model: LocalSttModel; local: LocalSttModelsState }>) {
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const { name } = localModelLabel(t, model.id);
  const size = formatModelSize(model.sizeBytes);
  const d = local.downloads[model.id];
  const busy = isLocalBusy(local.models, local.downloads, model.id);

  if (d?.status === "verifying") {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        {t("localStt.verifyingBody")}
      </div>
    );
  }

  if (busy) {
    const percent = d?.status === "downloading" ? downloadPercent(d.received, d.total) : 0;
    return (
      <div className="flex flex-col gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("localStt.downloadingBody", { name, percent })}
          </span>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={() => local.cancel(model.id)}>
            <X className="size-3.5" />
            {t("localStt.cancel")}
          </Button>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  if (model.installed) {
    return (
      <div className="flex flex-col gap-2">
        <SlowNote model={model} local={local} />
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-success-foreground">
            <Check className="size-3.5" />
            {t("localStt.ready", { name })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[11px] text-muted-foreground"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-3.5" />
            {t("localStt.delete")}
          </Button>
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogTitle>{t("localStt.delete")}</AlertDialogTitle>
              <AlertDialogDescription>{t("localStt.deleteConfirm", { name, size })}</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() =>
                    local.remove(model.id).catch((e) => {
                      log.warn("local-stt: delete failed", { modelId: model.id, error: String(e) });
                      toast.error(t("localStt.deleteFailed", { error: e instanceof Error ? e.message : String(e) }));
                    })
                  }
                >
                  {t("localStt.deleteConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  // Not installed: the "download it" callout, with the last attempt's outcome
  // and what this machine allows (see downloadGate).
  const retry = d?.status === "error" || d?.status === "cancelled";
  const gate = downloadGate(model.fit);
  const fit = presentFit(model, local.hardware, t);
  const reason = fit?.reason ? t(fit.reason.key, fit.reason.vars) : null;
  return (
    <div className="flex flex-col gap-2">
      {gate === "ok" && <SlowNote model={model} local={local} />}
      <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning px-3 py-2 text-warning-foreground">
        <p className="text-[11px] leading-relaxed">{t("localStt.callout.missing", { name })}</p>
        {gate === "confirm" && (
          <p className="flex items-start gap-1.5 rounded-md bg-danger px-2.5 py-1.5 text-[11px] leading-relaxed text-danger-foreground">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>
              {t("localStt.fit.ramLowWarning")} {reason}
            </span>
          </p>
        )}
        {d?.status === "error" && (
          <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">
            {t("localStt.failed", { error: d.message })}
          </p>
        )}
        {d?.status === "cancelled" && <p className="text-[11px]">{t("localStt.cancelled")}</p>}
        {gate === "blocked" ? (
          <>
            <Button size="sm" className="h-7 w-fit gap-1.5 text-[11px]" disabled>
              <Download className="size-3.5" />
              {t("localStt.download", { size })}
            </Button>
            {reason && <p className="text-[11px] leading-relaxed">{t("localStt.fit.diskBlocked", { reason })}</p>}
          </>
        ) : gate === "confirm" && confirmDownload ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              className="h-7 w-fit gap-1.5 text-[11px]"
              onClick={() => {
                setConfirmDownload(false);
                log.info("local-stt: download despite low RAM", { modelId: model.id });
                local.download(model.id);
              }}
            >
              <Download className="size-3.5" />
              {t("localStt.fit.downloadAnyway")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-fit text-[11px]"
              onClick={() => setConfirmDownload(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="h-7 w-fit gap-1.5 text-[11px]"
            onClick={() => (gate === "confirm" ? setConfirmDownload(true) : local.download(model.id))}
          >
            {retry ? <RotateCcw className="size-3.5" /> : <Download className="size-3.5" />}
            {retry ? t("localStt.retry") : t("localStt.download", { size })}
          </Button>
        )}
      </div>
    </div>
  );
}
