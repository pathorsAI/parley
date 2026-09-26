import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import {
  ANALYSIS_CACHE_PREFIX,
  SPEAKER_NAMES_CACHE_PREFIX,
  STUDY_CACHE_PREFIX,
  cacheBytesByPrefix,
  formatBytes,
} from "../lib/cache";
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

/** Matches `CacheKind` in src-tauri/src/cache.rs. */
type CacheKind = "transcription" | "diarization" | "analysis" | "all";

/** On-disk sizes, from the `cache_sizes` command. */
interface DiskSizes {
  transcription: number;
  diarization: number;
}

const ROWS: { kind: Exclude<CacheKind, "all">; labelKey: TranslationKey; helpKey: TranslationKey }[] = [
  { kind: "transcription", labelKey: "settings.caches.transcription", helpKey: "settings.caches.transcriptionHelp" },
  { kind: "diarization", labelKey: "settings.caches.diarization", helpKey: "settings.caches.diarizationHelp" },
  { kind: "analysis", labelKey: "settings.caches.analysis", helpKey: "settings.caches.analysisHelp" },
];

/**
 * The main window clears the localStorage caches when Rust's
 * `cache://clear-*` events reach it — a hop this window cannot await — so the
 * sizes are re-read after a beat rather than straight away.
 */
const REMEASURE_DELAY_MS = 400;

/** Bytes per cache: the on-disk directory plus whatever lives in localStorage. */
function measure(disk: DiskSizes | null): Record<Exclude<CacheKind, "all">, number> | null {
  if (!disk) return null;
  return {
    transcription: disk.transcription,
    diarization: disk.diarization + cacheBytesByPrefix(SPEAKER_NAMES_CACHE_PREFIX),
    analysis: cacheBytesByPrefix(ANALYSIS_CACHE_PREFIX, STUDY_CACHE_PREFIX),
  };
}

/**
 * Settings › MCP Server › Caches: size and clear each cache.
 *
 * The native Diagnostics → Clear Cache menu used to be the only door, and
 * Windows never draws a menu bar (the main window is undecorated), so there the
 * caches could not be cleared at all. The buttons call the same Rust code as
 * the menu (`clear_cache`, src-tauri/src/cache.rs), which also emits the
 * `cache://clear-*` events the main window clears its localStorage caches on.
 * Shown on both platforms; macOS keeps the menu too.
 */
export function CachesPanel() {
  const { t } = useI18n();
  const [disk, setDisk] = useState<DiskSizes | null>(null);
  const [busy, setBusy] = useState<CacheKind | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const remeasureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    invoke<DiskSizes>("cache_sizes")
      .then(setDisk)
      .catch((error) => log.warn("caches: size check failed", { error: String(error) }));
  }, []);

  useEffect(() => {
    refresh();
    return () => clearTimeout(remeasureTimer.current);
  }, [refresh]);

  async function clear(kind: CacheKind) {
    setBusy(kind);
    try {
      await invoke("clear_cache", { kind });
      const row = ROWS.find((r) => r.kind === kind);
      toast.success(
        row ? t("settings.caches.cleared", { name: t(row.labelKey) }) : t("settings.caches.clearedAll"),
      );
    } catch (error) {
      log.error("caches: clear failed", { kind, error: String(error) });
      toast.error(t("settings.caches.clearFailed", { error: String(error) }));
    } finally {
      setBusy(null);
      clearTimeout(remeasureTimer.current);
      remeasureTimer.current = setTimeout(refresh, REMEASURE_DELAY_MS);
    }
  }

  const sizes = measure(disk);
  const desktop = isTauri();

  return (
    <>
      <p className="text-[11px] text-muted-foreground">{t("settings.caches.help")}</p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {ROWS.map((row) => (
          <li key={row.kind} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{t(row.labelKey)}</span>
              <span className="text-[11px] text-muted-foreground">{t(row.helpKey)}</span>
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {sizes ? formatBytes(sizes[row.kind]) : "—"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-[11px]"
              disabled={!desktop || busy !== null}
              onClick={() => void clear(row.kind)}
            >
              {busy === row.kind ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t("settings.caches.clear")}
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-danger-foreground"
          disabled={!desktop || busy !== null}
          onClick={() => setConfirmAll(true)}
        >
          {busy === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          {t("settings.caches.clearAll")}
        </Button>
      </div>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("settings.caches.confirmAll.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("settings.caches.confirmAll.body")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.caches.confirmAll.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void clear("all")}>
              {t("settings.caches.confirmAll.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
