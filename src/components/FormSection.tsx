import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The form layout onboarding set: a section is a soft card headed by a pill
 * (icon + name) with a one-line note opposite, holding field panels; a panel
 * is one field — small grey label, the control, and an 11px hint under it.
 * Used by onboarding's model step and the meeting draft.
 */
export function FormSection({
  icon,
  label,
  note,
  children,
}: Readonly<{ icon: ReactNode; label: string; note?: string; children: ReactNode }>) {
  return (
    <section className="flex flex-col gap-3 rounded-[8px] bg-linear-to-b from-[#f5f5f5] to-[#fafafa] p-4 dark:from-muted dark:to-muted/60">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-sm leading-[1.3] dark:bg-white/10">
          {icon}
          {label}
        </span>
        {note && (
          <span className="text-right text-xs leading-relaxed text-[#333]/70 dark:text-muted-foreground">{note}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/** One field inside a {@link FormSection}. */
export function FieldPanel({ className, children }: Readonly<{ className?: string; children: ReactNode }>) {
  return <div className={cn("flex flex-col gap-2 rounded-[10px] bg-white/50 p-3 dark:bg-white/5", className)}>{children}</div>;
}

/** A field's label: small and grey, with an optional 必填 / 選填 tag. */
export function FieldLabel({ label, tag, htmlFor }: Readonly<{ label: string; tag?: string; htmlFor?: string }>) {
  const Tag = htmlFor ? "label" : "span";
  return (
    <Tag htmlFor={htmlFor} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {tag && <span className="rounded bg-muted px-1.5 py-px text-[10px] font-normal">{tag}</span>}
    </Tag>
  );
}

/** A field's hint, under its control. */
export function FieldHint({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="text-[11px] leading-snug text-muted-foreground">{children}</p>;
}

/** Onboarding's input look: rounded, a light border, comfortable padding. */
export const FORM_INPUT_CLASS =
  "rounded-[10px] border border-[#dadee5] bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input";
