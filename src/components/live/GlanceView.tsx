import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { FindingRow } from "../analysis/FindingRow";
import { openSolution, selectAndSeek } from "../analysis/useAnalysis";
import { LevelMeter } from "../LevelMeter";

/**
 * The "glance" preset: a single narrow column for when Parley is docked beside
 * (or floating over) the meeting app — the now-card, the counterpart's last
 * line, and the confidence meter. Nothing to read, everything to glance.
 */
export function GlanceView({ onSeek }: Readonly<{ onSeek: (ms: number) => void }>) {
  const { t } = useI18n();
  const findings = useStore((s) => s.findings);
  const selectedId = useStore((s) => s.selectedFindingId);
  const segments = useStore((s) => s.segments);
  const recording = useStore((s) => s.meetingStatus === "recording");

  const latest = findings.length > 0 ? findings[findings.length - 1] : null;
  const lastThem = [...segments].reverse().find((s) => s.source === "them" && s.text.trim());

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      {/* The now-card: the most recent coach signal. */}
      {latest ? (
        <FindingRow
          event={latest}
          selected={latest.id === selectedId}
          onSelect={(ev) => selectAndSeek(ev, onSeek)}
          onOpenSolution={(ev) => openSolution(ev, onSeek)}
        />
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("glance.noSignal")}
        </p>
      )}

      {/* The counterpart's last line (with translation when present). */}
      {lastThem && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-600 dark:text-sky-400">
            {t("speaker.them")}
          </p>
          <p>{lastThem.text}</p>
          {lastThem.translation && (
            <p className="mt-0.5 text-[13px] italic text-sky-600/80 dark:text-sky-400/80">
              → {lastThem.translation}
            </p>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
        {recording && (
          <>
            <span className="size-2 animate-pulse rounded-full bg-red-500" />
            <LevelMeter source="me" className="h-1.5 w-16" />
          </>
        )}
      </div>
    </div>
  );
}
