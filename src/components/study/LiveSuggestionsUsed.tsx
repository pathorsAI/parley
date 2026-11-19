import { useMemo } from "react";
import { Check, ChevronDown, Minus } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { resolveSelf } from "../../lib/speakers/self";
import { adoptionReport } from "../../lib/meeting/suggestAdoption";
import { useI18n } from "../../i18n";

/**
 * 表達's 即時建議: how many of the live suggestions shown during the meeting
 * the user went on to say, read from the transcript (meeting/suggestAdoption.ts).
 * A line, and the list behind it. Nothing for a recording that showed none.
 */
export function LiveSuggestionsUsed({ onSeek }: Readonly<{ onSeek: (ms: number) => void }>) {
  const { t } = useI18n();
  const shown = useStore((s) => s.replay?.liveSuggestions);
  const segments = useStore((s) => s.segments);
  const selfSpeaker = useStore((s) => s.selfSpeaker);
  const micActivity = useStore((s) => s.replay?.micActivity);
  const voiceSelf = useStore((s) => s.voiceSelfKey);
  const self = resolveSelf(segments, selfSpeaker, micActivity, voiceSelf);
  const report = useMemo(
    () => adoptionReport(shown, segments, (seg) => !!self?.isSelf(seg)),
    [shown, segments, self],
  );
  if (report.shown === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-xs font-semibold text-muted-foreground">{t("liveSuggest.report.title")}</h2>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm">
          <span>
            {t("liveSuggest.report.summary", {
              shown: report.shown,
              used: report.used,
              rate: Math.round((report.rate ?? 0) * 100),
            })}
          </span>
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {!self && <p className="mt-1 text-xs text-muted-foreground">{t("liveSuggest.report.noSelf")}</p>}
        <ul className="mt-2 flex flex-col gap-1.5">
          {report.outcomes.map(({ suggestion, saidIn }) => (
            <li key={`${suggestion.key}-${suggestion.atMs}`} className="flex items-start gap-2 text-sm leading-snug">
              {saidIn ? (
                <Check aria-label={t("liveSuggest.report.used")} className="mt-0.5 size-4 shrink-0 text-success-foreground" />
              ) : (
                <Minus aria-label={t("liveSuggest.report.unused")} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className={`min-w-0 flex-1 ${saidIn ? "text-foreground" : "text-muted-foreground"}`}>
                {suggestion.text}
              </span>
              <button
                type="button"
                title={t("agenda.jump")}
                onClick={() => onSeek(saidIn?.startMs ?? suggestion.atMs)}
                className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-px text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              >
                {formatClock(suggestion.atMs)}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
