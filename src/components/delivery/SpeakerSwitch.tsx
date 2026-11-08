import { CircleCheck, UserRound } from "lucide-react";
import { displaySpeakerLabel } from "../../lib/speakers/labels";
import { markSelfSpeaker } from "../../lib/speakers/markSelf";
import type { RosterEntry, SelfOrigin } from "../../lib/speakers/self";
import { useI18n, type TranslationKey } from "../../i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ORIGIN_KEY: Record<SelfOrigin, TranslationKey> = {
  marked: "delivery.self.origin.marked",
  "mic-track": "delivery.self.origin.micTrack",
  "mic-activity": "delivery.self.origin.micActivity",
  voice: "delivery.self.origin.voice",
};

/**
 * The 評分 page's speaker switch: one segmented row, a segment per speaker
 * with their share of the talk, the user first and marked with a person icon.
 * At the row's end sits the one thing to know or do about the speaker on
 * screen: "this is you" (and how Parley knows), or a 這是我 button.
 */
export function SpeakerSwitch({
  roster,
  viewed,
  onView,
  names,
  origin,
  marked,
}: Readonly<{
  roster: RosterEntry[];
  viewed: RosterEntry;
  onView: (key: string) => void;
  names: Record<string, string>;
  /** How Parley knew who the user is; null = it doesn't. */
  origin: SelfOrigin | null;
  /** The speaker the user marked, if any. */
  marked: string | null;
}>) {
  const { t } = useI18n();
  const total = roster.reduce((sum, sp) => sum + sp.talkMs, 0);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div
        role="tablist"
        aria-label={t("delivery.speaker.aria")}
        className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {roster.map((sp) => {
          const on = sp.key === viewed.key;
          const share = total > 0 ? Math.round((sp.talkMs / total) * 100) : 0;
          return (
            <button
              key={sp.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onView(sp.key)}
              className={cn(
                "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
                on
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sp.isSelf && (
                <UserRound className="size-3.5 text-primary" aria-label={t("delivery.speaker.me")} />
              )}
              {displaySpeakerLabel(sp, names, t)}
              <span className="text-[10px] tabular-nums text-muted-foreground">{share}%</span>
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex items-center gap-1.5 text-xs">
        <Identity viewed={viewed} origin={origin} marked={marked} />
      </div>
    </div>
  );
}

/** Who the speaker on screen is to Parley, and the one action that changes it. */
function Identity({
  viewed,
  origin,
  marked,
}: Readonly<{ viewed: RosterEntry; origin: SelfOrigin | null; marked: string | null }>) {
  const { t } = useI18n();
  if (viewed.isSelf && origin) {
    return (
      <>
        <CircleCheck className="size-3.5 text-primary" />
        <span className="text-foreground">{t("delivery.speaker.you")}</span>
        <span className="text-muted-foreground">· {t(ORIGIN_KEY[origin])}</span>
        {marked === viewed.key && (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => markSelfSpeaker(null)}>
            {t("delivery.speaker.unmark")}
          </Button>
        )}
      </>
    );
  }
  // Nobody is the user yet: the button is the page's question, so it stands
  // out; once someone is, re-marking is a quieter correction.
  return (
    <Button
      size="sm"
      variant={origin ? "ghost" : "outline"}
      className={origin ? "text-muted-foreground" : undefined}
      onClick={() => markSelfSpeaker(viewed.key)}
    >
      <UserRound />
      {t("delivery.speaker.markMe")}
    </Button>
  );
}
