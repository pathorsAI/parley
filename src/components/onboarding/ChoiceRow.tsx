import type { ReactNode } from "react";

/**
 * One option of an onboarding either/or (organization, hosted vs own models):
 * a bordered card with a radio dot, a label and a muted note. Render several
 * inside an element with role="radiogroup". `children` (a field the option
 * needs, like the new organization's name) sit inside the same card, under
 * the label — outside the radio itself, since a button can't hold an input.
 */
export function ChoiceRow({
  selected,
  label,
  note,
  onSelect,
  children,
}: Readonly<{
  selected: boolean;
  label: string;
  note: string;
  onSelect: () => void;
  children?: ReactNode;
}>) {
  return (
    <div
      className={`rounded-lg border transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={`mt-[3px] size-3.5 shrink-0 rounded-full ${
            selected ? "border-4 border-primary" : "border border-input"
          }`}
        />
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-sm">{label}</span>
          <span className="text-[11px] text-muted-foreground">{note}</span>
        </span>
      </button>
      {children && <div className="pr-3 pb-3 pl-9">{children}</div>}
    </div>
  );
}
