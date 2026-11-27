import { Coffee, Flag, X } from "lucide-react";
import { useLiveMeeting } from "../../lib/meeting/liveSession";
import { meetingCommand } from "../../lib/meeting/meetingWindow";
import { openingShowing } from "../../lib/meeting/opening";
import { useI18n } from "../../i18n";

/**
 * The opening (開場), on screen from the first second of the meeting: the
 * small-talk lines, then the standard opening to say. Not a suggestion that
 * comes and goes — it stays until the user has said it (openingRun.ts) or puts
 * it away here, and live suggestions wait for it. Nothing at all when the
 * draft had no opening.
 *
 * `compact`: the mini window's size. The caller's `className` places and
 * sizes it (a max height, or the room it fills).
 */
export function OpeningCard({ compact = false, className = "" }: Readonly<{ compact?: boolean; className?: string }>) {
  const { t } = useI18n();
  const showing = useLiveMeeting(openingShowing);
  const opening = useLiveMeeting((s) => s.meetingOpening);
  if (!showing) return null;
  const text = compact ? "text-xs" : "text-sm";
  const icon = compact ? "mt-[3px] size-3" : "mt-0.5 size-3.5";
  return (
    <section
      aria-label={t("opening.label")}
      data-no-drag
      className={`flex cursor-text select-text items-start gap-2 overflow-y-auto rounded-lg border bg-background ${
        compact ? "px-2 py-1.5" : "px-3 py-2.5"
      } ${className}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {opening.smallTalk.length > 0 && (
          <div className="flex items-start gap-2">
            <Coffee className={`${icon} shrink-0 text-muted-foreground`} />
            <ul className="flex min-w-0 flex-1 flex-col gap-1">
              {opening.smallTalk.map((line) => (
                <li key={line} className={`${text} leading-snug text-muted-foreground`}>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        {opening.script && (
          <div className="flex items-start gap-2">
            <Flag className={`${icon} shrink-0 text-primary`} />
            <p className={`min-w-0 flex-1 whitespace-pre-wrap ${text} leading-snug text-foreground`}>{opening.script}</p>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={t("opening.dismiss")}
        title={t("opening.dismiss")}
        onClick={() => meetingCommand("dismissOpening")}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </section>
  );
}
