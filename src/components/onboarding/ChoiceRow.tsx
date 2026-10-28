/**
 * One option of an onboarding either/or (organization, hosted vs own models):
 * a bordered row with a radio dot, a label and a muted note. Render several
 * inside an element with role="radiogroup".
 */
export function ChoiceRow({
  selected,
  label,
  note,
  onSelect,
}: Readonly<{
  selected: boolean;
  label: string;
  note: string;
  onSelect: () => void;
}>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
      }`}
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
  );
}
