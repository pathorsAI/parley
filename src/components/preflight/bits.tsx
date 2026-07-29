import { useState, type ReactNode } from "react";
import { Check, Plus, X } from "lucide-react";

/** Shared chrome for the three pre-flight columns. */

export function Column({
  step,
  title,
  children,
}: Readonly<{ step: string; title: string; children: ReactNode }>) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-[10px] font-bold tabular-nums text-muted-foreground/70">{step}</span>
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </div>
  );
}

export function Field({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function SectionTitle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * "＋" that swaps into a one-line input, for creating a company, a thread, or a
 * person without leaving pre-flight — the alternative is bouncing to the
 * accounts workspace mid-setup, which is exactly the trip this screen exists to
 * remove.
 *
 * Controlled, because the open input needs the row to ITSELF: the field it sits
 * in is one combobox wide, and three more controls beside that combobox blow
 * the column out sideways. The caller hides the picker while `open`.
 */
export function InlineCreate({
  label,
  placeholder,
  confirmLabel,
  cancelLabel,
  open,
  onOpenChange,
  onCreate,
}: Readonly<{
  label: string;
  placeholder: string;
  confirmLabel: string;
  cancelLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}>) {
  const [value, setValue] = useState("");

  function close() {
    setValue("");
    onOpenChange(false);
  }

  function commit() {
    const name = value.trim();
    if (!name) return;
    onCreate(name);
    close();
  }

  if (!open) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => onOpenChange(true)}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    );
  }
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- replaces the button the user just clicked */}
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") close();
        }}
        placeholder={placeholder}
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <button
        type="button"
        aria-label={confirmLabel}
        title={confirmLabel}
        onClick={commit}
        disabled={!value.trim()}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      >
        <Check className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={cancelLabel}
        title={cancelLabel}
        onClick={close}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </>
  );
}

/**
 * Empty state for a column that has nothing to show yet. A drawn mark rather
 * than a bare sentence: pre-flight is three columns wide, and one of them is
 * routinely empty (an unlinked or brand-new company) — blank space there reads
 * as a rendering bug.
 */
export function EmptyState({
  title,
  hint,
  glyph,
}: Readonly<{ title: string; hint: string; glyph: "radar" | "notes" }>) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <svg
        viewBox="0 0 64 64"
        aria-hidden
        className="size-16 text-muted-foreground/25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph === "radar" ? (
          <>
            <circle cx="32" cy="32" r="22" />
            <circle cx="32" cy="32" r="13" />
            <circle cx="32" cy="32" r="4" className="text-muted-foreground/40" />
            <path d="M32 32 L48 18" />
            <path d="M8 32h6M50 32h6M32 8v6M32 50v6" />
          </>
        ) : (
          <>
            <rect x="14" y="10" width="36" height="44" rx="4" />
            <path d="M23 24h18M23 33h18M23 42h11" />
          </>
        )}
      </svg>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <p className="max-w-52 text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p>
      </div>
    </div>
  );
}
