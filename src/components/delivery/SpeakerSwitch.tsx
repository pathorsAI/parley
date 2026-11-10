import { UserRound } from "lucide-react";
import { displaySpeakerLabel } from "../../lib/speakers/labels";
import { markSelfSpeaker } from "../../lib/speakers/markSelf";
import type { RosterEntry, SelfOrigin } from "../../lib/speakers/self";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";


/**
 * The 評分 page's speaker switch: shadcn tabs, one per speaker
 * with their share of the talk, the user first and marked with a person icon.
 * At the row's end sits the one action for the speaker on screen: undo the
 * user's own mark, or a 這是我 button.
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
      {/* shadcn Tabs: the speakers are views of one report, so only the
          trigger row is used — the report under it is the content. */}
      <Tabs value={viewed.key} onValueChange={onView} className="max-w-full">
        <TabsList aria-label={t("delivery.speaker.aria")} className="max-w-full">
          {roster.map((sp) => {
            const share = total > 0 ? Math.round((sp.talkMs / total) * 100) : 0;
            return (
              <TabsTrigger key={sp.key} value={sp.key} className="flex-none gap-2 px-3 text-xs">
                {sp.isSelf && <UserRound data-icon="inline-start" className="size-3.5" aria-label={t("delivery.speaker.me")} />}
                {displaySpeakerLabel(sp, names, t)}
                <span className="font-normal tabular-nums text-muted-foreground">{share}%</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
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
  // The speaker on screen is the user: the tab's person icon already says so,
  // so all that is left is undoing a mark the user made (an automatic match
  // has nothing to undo here).
  if (viewed.isSelf && origin) {
    if (marked !== viewed.key) return null;
    return (
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => markSelfSpeaker(null)}>
        {t("delivery.speaker.unmark")}
      </Button>
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
