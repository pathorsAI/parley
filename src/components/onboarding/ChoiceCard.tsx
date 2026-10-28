import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One side of an onboarding either/or drawn as a card, from the Figma sign-in
 * and organization frames: a soft pill naming the choice (with an optional
 * note beside it), whatever the choice needs (a line of copy, a name field),
 * and the card's own button bottom-right, over a fade and a piece of line art.
 * `primary` is the blue card (the recommended way), otherwise grey. `fill`
 * makes the cards share the dialog's height (sign-in); without it each is as
 * tall as its content (organization).
 */
export function ChoiceCard({
  primary = false,
  fill = false,
  icon,
  label,
  note,
  art,
  action,
  children,
}: Readonly<{
  primary?: boolean;
  fill?: boolean;
  icon: ReactNode;
  label: string;
  note?: string;
  /** The line art: its file and where it sits, as drawn. */
  art: { src: string; className: string };
  action: ReactNode;
  children?: ReactNode;
}>) {
  return (
    <section
      className={cn(
        "relative flex flex-col items-end overflow-hidden rounded-[8px] p-5",
        fill ? "min-h-fit flex-1 basis-0 justify-between gap-2" : "gap-8",
        primary
          ? "bg-linear-to-b from-[#e1f2fd] to-white dark:from-primary/15 dark:to-transparent"
          : "bg-linear-to-b from-[#f5f5f5] to-[#fafafa] dark:from-muted dark:to-muted/60",
      )}
    >
      <div aria-hidden className={cn("pointer-events-none absolute", art.className)}>
        <img src={art.src} alt="" className="size-full max-w-none" />
      </div>
      <div className="relative flex w-full flex-col gap-6">
        <div className="flex w-full items-center justify-between gap-3">
          <span
            className={cn(
              "inline-flex w-fit shrink-0 items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-sm leading-[1.3] dark:bg-white/10",
              primary && "text-primary",
            )}
          >
            {icon}
            {label}
          </span>
          {note && <p className="text-right text-sm leading-relaxed text-[#333]/70 dark:text-muted-foreground">{note}</p>}
        </div>
        {children}
      </div>
      <div className="relative">{action}</div>
    </section>
  );
}

/** The "or" between two choice cards. */
export function OrDivider({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground" aria-hidden>
      <span className="h-px flex-1 bg-[#e6e6e6] dark:bg-border" />
      {label}
      <span className="h-px flex-1 bg-[#e6e6e6] dark:bg-border" />
    </div>
  );
}
