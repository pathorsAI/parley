import { Lightbulb } from "lucide-react";
import { useStore } from "../../lib/store";
import { useLiveMeeting } from "../../lib/meeting/liveSession";
import { CLOUD_ENABLED } from "../../lib/flags";
import { useI18n, type TranslationKey } from "../../i18n";
import type { SuggestKind, Suggestion } from "../../lib/meeting/liveSuggest";

const KIND_LABEL: Record<SuggestKind, TranslationKey> = {
  question: "liveSuggest.kind.question",
  branch: "liveSuggest.kind.branch",
  topic: "liveSuggest.kind.topic",
  generated: "liveSuggest.kind.generated",
};

/** Where a line came from, in a few words: a branch names what they said. */
function originLabel(item: Suggestion, t: (key: TranslationKey, vars?: Record<string, string>) => string): string {
  if (item.kind === "branch" && item.source) return t("liveSuggest.origin.branch", { when: item.source });
  return t(KIND_LABEL[item.kind]);
}

/**
 * The live suggestion (即時建議), between the agenda and the tabs so it shows
 * on every tab (and above the main window's live screen): one line to say after the other side finishes a sentence, or a
 * few directions when the talk runs dry. Nothing to click — it leaves on its
 * own (meeting/liveSuggest.ts cardExpired), and whether it was used is read
 * from the transcript afterwards. Renders nothing when there is no card.
 */
export function LiveSuggestionBar({ className = "mx-5 mt-3" }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  const card = useLiveMeeting((s) => s.liveSuggestion);
  const on = useStore((s) => s.settings.liveSuggestions);
  if (!CLOUD_ENABLED || !on || !card || card.items.length === 0) return null;
  const lull = card.mode === "lull";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`${className} shrink-0 animate-in fade-in-0 slide-in-from-top-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 duration-200`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
        <Lightbulb className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{lull ? t("liveSuggest.lull") : originLabel(card.items[0], t)}</span>
      </p>
      {lull ? (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {card.items.map((item) => (
            <li key={item.key} className="rounded-full border bg-background px-2 py-0.5 text-xs text-foreground">
              {item.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 text-sm leading-snug text-foreground">{card.items[0].text}</p>
      )}
    </div>
  );
}

/** The 即時建議 switch, beside the background button. Needs a Parley Cloud
 *  sign-in: the suggestions are made there. */
export function LiveSuggestToggle() {
  const { t } = useI18n();
  const on = useStore((s) => s.settings.liveSuggestions);
  const signedIn = useStore((s) => !!s.cloudAuth?.token);
  const updateSettings = useStore((s) => s.updateSettings);
  if (!CLOUD_ENABLED) return null;
  const label = signedIn ? t(on ? "liveSuggest.turnOff" : "liveSuggest.turnOn") : t("liveSuggest.signIn");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={!signedIn}
      onClick={() => updateSettings({ liveSuggestions: !on })}
      className={`grid size-9 shrink-0 place-items-center rounded-[10px] border transition-colors hover:bg-muted disabled:opacity-50 ${
        on && signedIn ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-foreground/80"
      }`}
    >
      <Lightbulb className="size-4" />
    </button>
  );
}
