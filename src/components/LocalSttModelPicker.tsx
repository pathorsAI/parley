import { useState } from "react";
import { Check, Download, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import {
  DEFAULT_LOCAL_STT_MODEL,
  downloadPercent,
  formatModelSize,
  isLocalBusy,
  localModelLabel,
  sortLocalModels,
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
 */
export function LocalSttModelPicker({
  value,
  onChange,
  local,
}: Readonly<{
  value: string;
  onChange: (modelId: string) => void;
  local: LocalSttModelsState;
}>) {
  const { t } = useI18n();
  const { models, loadError } = local;

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
      <div role="radiogroup" aria-label={t("localStt.picker.label")} className="flex flex-col gap-1.5">
        {sortLocalModels(models).map((m) => (
          <ModelCard key={m.id} model={m} selected={m.id === value} local={local} onSelect={() => onChange(m.id)} />
        ))}
      </div>
      {selected && <SelectedModelActions model={selected} local={local} />}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("localStt.note")}</p>
    </div>
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
          {model.id === DEFAULT_LOCAL_STT_MODEL && (
            <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-normal text-primary">
              {t("localStt.recommended")}
            </span>
          )}
        </span>
        {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
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

function Badge({ tone, children }: Readonly<{ tone: "success" | "info" | "muted"; children: React.ReactNode }>) {
  const cls = {
    success: "bg-success text-success-foreground",
    info: "bg-info text-info-foreground",
    muted: "bg-muted text-muted-foreground",
  }[tone];
  return <span className={`rounded px-1.5 py-px text-[10px] tabular-nums ${cls}`}>{children}</span>;
}

/** The download / progress / retry / delete area for the selected model. */
function SelectedModelActions({ model, local }: Readonly<{ model: LocalSttModel; local: LocalSttModelsState }>) {
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    );
  }

  // Not installed: the "download it" callout, with the last attempt's outcome.
  const retry = d?.status === "error" || d?.status === "cancelled";
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning px-3 py-2 text-warning-foreground">
      <p className="text-[11px] leading-relaxed">{t("localStt.callout.missing", { name })}</p>
      {d?.status === "error" && (
        <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">
          {t("localStt.failed", { error: d.message })}
        </p>
      )}
      {d?.status === "cancelled" && <p className="text-[11px]">{t("localStt.cancelled")}</p>}
      <Button size="sm" className="h-7 w-fit gap-1.5 text-[11px]" onClick={() => local.download(model.id)}>
        {retry ? <RotateCcw className="size-3.5" /> : <Download className="size-3.5" />}
        {retry ? t("localStt.retry") : t("localStt.download", { size })}
      </Button>
    </div>
  );
}
