import { useEffect, useState } from "react";
import { FileText, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { formatClock, useStore } from "../lib/store";
import {
  prepareTranscriptFile,
  type PreparedTranscriptFile,
} from "../lib/replay/importFiles";
import { loadHistoryEntry, saveTranscriptToHistory } from "../lib/history/history";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DestinationPicker } from "./DestinationPicker";
import {
  personalDestination,
  PERSONAL_ROOT,
  type LibraryDestination,
  type OrgHandoffMode,
} from "../lib/library/destination";

/**
 * Import picked/dropped .txt transcripts as audio-less history entries (issue
 * #130's text-ingest path). Shows one row per file (parsed stats + editable
 * title), a shared target folder, and saves on confirm. A single imported
 * transcript opens straight into replay — where the study pipeline runs its
 * first analysis; a batch stays put so importing a folder's worth of history
 * never spends model calls up front.
 */
export function TranscriptImportDialog() {
  const { t } = useI18n();
  const paths = useStore((s) => s.transcriptImportPaths);
  const prefillFolderId = useStore((s) => s.transcriptImportFolderId);
  const close = useStore((s) => s.closeTranscriptImport);

  const [files, setFiles] = useState<PreparedTranscriptFile[] | null>(null);
  // Where these transcripts go. Asked HERE because a transcript imported into
  // no folder is exactly the recording that later needs after-the-fact filing.
  // An org destination hands each saved entry over afterwards — this path never
  // ran through resolveMeetingSave, so before this it could not reach an org at
  // all, not even via the settings-wide auto-share default.
  const [destination, setDestination] = useState<LibraryDestination>(PERSONAL_ROOT);
  const [handoff, setHandoff] = useState<OrgHandoffMode | null>(null);
  const [importing, setImporting] = useState(false);

  // (Re)prepare whenever the dialog opens with a new set of paths.
  useEffect(() => {
    if (!paths) {
      setFiles(null);
      return;
    }
    let alive = true;
    setFiles(null);
    // A folder door pre-picks its folder (R7); every other door starts blank
    // and asks.
    setDestination(personalDestination(prefillFolderId ?? null));
    setHandoff(null);
    Promise.all(paths.map(prepareTranscriptFile)).then((prepared) => {
      if (alive) setFiles(prepared);
    });
    return () => {
      alive = false;
    };
  }, [paths, prefillFolderId]);

  if (!paths) return null;

  const ready = files !== null;
  const valid = (files ?? []).filter((f) => f.parsed !== null);

  function setTitle(path: string, title: string) {
    setFiles((prev) => prev?.map((f) => (f.path === path ? { ...f, title } : f)) ?? null);
  }

  async function confirm() {
    if (!valid.length || importing) return;
    setImporting(true);
    const imported: string[] = [];
    try {
      for (const f of valid) {
        const parsed = f.parsed;
        if (!parsed) continue;
        const id = await saveTranscriptToHistory({
          title: f.title.trim() || f.fileName,
          segments: parsed.segments,
          speakerNames: parsed.speakerNames,
          durationMs: parsed.durationMs,
          createdAt: f.createdAt,
          // An org destination still writes locally first: the share endpoint
          // copies from the user's own cloud keyspace, so the entry has to
          // exist before it can be handed over.
          folderId: destination.scope === "personal" ? destination.folderId : null,
        });
        if (id) imported.push(id);
      }
      if (destination.scope === "org") {
        const { moveRecordingToOrg, shareRecordingToOrg } = await import("../lib/cloud/sync");
        for (const id of imported) {
          if (handoff === "move") {
            await moveRecordingToOrg(id, destination.orgId, destination.folderId);
          } else {
            await shareRecordingToOrg(id, destination.orgId, destination.folderId);
          }
        }
      }
    } catch (e) {
      log.error("import: transcript save failed", { error: String(e) });
      toast.error(t("import.failed", { error: e instanceof Error ? e.message : String(e) }));
      setImporting(false);
      return;
    }
    setImporting(false);
    close();
    toast.success(t("import.done", { count: imported.length }));
    // One transcript → jump straight into it (its first analysis runs on open).
    // A batch stays in the grid; each entry analyzes when first opened. A move
    // left no local entry to open — that copy lives in the org now.
    const movedOut = destination.scope === "org" && handoff === "move";
    if (imported.length === 1 && !movedOut) {
      loadHistoryEntry(imported[0]).catch((e) =>
        log.error("import: open after import failed", { id: imported[0], error: String(e) }),
      );
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-xl border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <FileText className="size-4 text-emerald-400" />
          <span className="text-sm font-semibold">{t("import.title")}</span>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{t("import.intro")}</p>

          {!ready && (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-emerald-400" />
              {t("import.reading")}
            </div>
          )}

          {ready && (
            <div className="flex flex-col gap-1.5">
              {files?.map((f) => (
                <div key={f.path} className="flex flex-col gap-1 rounded-md border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={f.title}
                      onChange={(e) => setTitle(f.path, e.target.value)}
                      disabled={f.parsed === null}
                      className="h-7 flex-1 text-xs"
                    />
                  </div>
                  {f.parsed ? (
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3" />
                        {t("import.speakers", {
                          count: Math.max(1, Object.keys(f.parsed.speakerNames).length || 1),
                        })}
                      </span>
                      <span>{t("import.segments", { count: f.parsed.segments.length })}</span>
                      <span className="font-mono tabular-nums">{formatClock(f.parsed.durationMs)}</span>
                      <span className="min-w-0 flex-1 truncate text-right" title={f.fileName}>
                        {f.fileName}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[11px] text-orange-400">
                      {f.error === "empty" ? t("import.empty") : t("import.readFailed", { error: f.error ?? "—" })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {ready && (
            <div className="flex flex-col gap-1.5 border-t pt-3">
              <span className="text-[11px] text-muted-foreground">{t("owner.label")}</span>
              <DestinationPicker
                value={destination}
                mode={handoff}
                onChange={(next, mode) => {
                  setDestination(next);
                  setHandoff(mode);
                }}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("import.cancel")}
          </button>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={!ready || !valid.length || importing}
            onClick={() => void confirm()}
          >
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            {t("import.confirm", { count: valid.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
