import { Lightbulb, MessageCircleQuestion } from "lucide-react";
import { useStore } from "../../lib/store";
import { CLOUD_ENABLED } from "../../lib/flags";
import { useLiveMeeting } from "../../lib/meeting/liveSession";
import { meetingCommand } from "../../lib/meeting/meetingWindow";
import { useI18n } from "../../i18n";
import type { ShownCard } from "../../lib/meeting/liveSuggest";

/** The live suggestion on screen, or null: none, or the switch is off. */
export function useLiveSuggestionCard(): ShownCard | null {
  const card = useLiveMeeting((s) => s.liveSuggestion);
  const on = useStore((s) => s.settings.liveSuggestions);
  if (!CLOUD_ENABLED || !on || !card || card.items.length === 0) return null;
  return card;
}

/**
 * The live suggestion (即時建議), as little as it can be: an icon, then the
 * line or lines to say — a light bulb after the other side's line, a question
 * bubble for directions in a lull. No title, no label, no reason; nothing at
 * all when there is no suggestion. It leaves on its own (cardExpired), and
 * whether it was used is read from the transcript afterwards.
 *
 * `compact`: the mini window's size.
 */
export function LiveSuggestionLines({
  card,
  compact = false,
  className = "",
}: Readonly<{ card: ShownCard; compact?: boolean; className?: string }>) {
  const Icon = card.mode === "lull" ? MessageCircleQuestion : Lightbulb;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex shrink-0 animate-in fade-in-0 items-start gap-2 duration-200 ${className}`}
    >
      <Icon className={`${compact ? "mt-[3px] size-3" : "mt-0.5 size-3.5"} shrink-0 text-primary`} />
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {card.items.map((item) => (
          <li key={item.key} className={`${compact ? "text-xs" : "text-sm"} leading-snug text-foreground`}>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The full window's suggestion, between the title and the tabs so it shows on
 *  every tab (and above the main window's live screen). */
export function LiveSuggestionBar({ className = "mx-5 mt-3" }: Readonly<{ className?: string }>) {
  const card = useLiveSuggestionCard();
  if (!card) return null;
  return <LiveSuggestionLines card={card} className={`${className} rounded-lg bg-primary/10 px-3 py-2`} />;
}

/** The 即時建議 switch, beside the background button. Needs a Parley Cloud
 *  sign-in: the suggestions are made there. Switched by the main window, which
 *  owns the persisted settings (meetingWindow.ts toggleLiveSuggest). */
export function LiveSuggestToggle() {
  const { t } = useI18n();
  const on = useStore((s) => s.settings.liveSuggestions);
  const signedIn = useStore((s) => !!s.cloudAuth?.token);
  if (!CLOUD_ENABLED) return null;
  const label = signedIn ? t(on ? "liveSuggest.turnOff" : "liveSuggest.turnOn") : t("liveSuggest.signIn");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={!signedIn}
      onClick={() => meetingCommand("toggleLiveSuggest")}
      className={`grid size-9 shrink-0 place-items-center rounded-[10px] border transition-colors hover:bg-muted disabled:opacity-50 ${
        on && signedIn ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-foreground/80"
      }`}
    >
      <Lightbulb className="size-4" />
    </button>
  );
}
