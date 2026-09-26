import { X } from "lucide-react";
import { useI18n } from "../i18n";
import { cn } from "@/lib/utils";

/**
 * A one-time contextual hint: one muted line with a close button. Deliberately
 * quiet — no surface, no accent — so it reads as a note in the margin rather
 * than a banner competing with the content it explains. Visibility is the
 * caller's (see `useHint` in lib/onboarding/gettingStarted.ts).
 */
export function OnboardingHint({
  text,
  onDismiss,
  className,
}: Readonly<{ text: string; onDismiss: () => void; className?: string }>) {
  const { t } = useI18n();
  return (
    <div
      role="note"
      className={cn("flex items-start gap-2 text-[11px] leading-snug text-muted-foreground", className)}
    >
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={onDismiss}
        className="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
