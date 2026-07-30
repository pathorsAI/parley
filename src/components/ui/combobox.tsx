import { useMemo, useState, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * THE searchable picker for this app. Option lists here grow without bound
 * (companies, threads, folders, stages), and a native `<select>` gives no
 * search, no grouping, and a different look on every surface — so every
 * multi-option choice runs through this one component instead.
 *
 * Built on Radix Popover rather than `cmdk` to avoid a dependency: the list is
 * a plain filtered render, which is all a few hundred options need.
 */

export interface ComboOption {
  value: string;
  label: string;
  /** Secondary text shown right-aligned (stage, count, kind…). */
  hint?: string;
}

export interface ComboGroup {
  /** Omit for an ungrouped list. */
  label?: string;
  options: ComboOption[];
}

function matches(option: ComboOption, q: string): boolean {
  return (
    option.label.toLowerCase().includes(q) || (option.hint ?? "").toLowerCase().includes(q)
  );
}

export function Combobox({
  value,
  groups,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  icon,
  size = "default",
  align = "start",
  contentClassName,
  className,
  disabled = false,
  title,
}: Readonly<{
  /** Selected option value; "" (or an unknown value) renders the placeholder. */
  value: string;
  groups: ComboGroup[];
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  icon?: ReactNode;
  /** `bare` drops the border — for titlebar/rail chips. */
  size?: "default" | "sm" | "bare";
  align?: "start" | "center" | "end";
  contentClassName?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(() => {
    for (const g of groups) {
      const hit = g.options.find((o) => o.value === value);
      if (hit) return hit;
    }
    return null;
  }, [groups, value]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({
          ...g,
          // A group-name hit keeps the whole group — searching "Pathors" should
          // surface that company's threads, not just the company row.
          options: g.label?.toLowerCase().includes(q)
            ? g.options
            : g.options.filter((o) => matches(o, q)),
        }))
        .filter((g) => g.options.length > 0)
    : groups;

  const triggerClass = {
    default:
      "h-9 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted/50",
    sm: "h-7 rounded-md border border-input bg-background px-2 text-xs hover:bg-muted/50",
    bare: "h-7 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
  }[size];

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title={title}
          disabled={disabled}
          aria-label={title ?? placeholder}
          className={cn(
            "flex w-full min-w-0 cursor-pointer items-center gap-1.5 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClass,
            className
          )}
        >
          {icon}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !selected && "text-muted-foreground"
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          {selected?.hint && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{selected.hint}</span>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          // z-[95]: above the Sheet overlay (z-[90]) so a combobox opened inside
          // a sheet isn't clipped or covered by it.
          className={cn(
            "z-[95] w-64 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg",
            contentClassName
          )}
        >
          <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- combobox pattern */}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-6 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</p>
            )}
            {filtered.map((g, gi) => (
              <div key={g.label ?? `g${gi}`} className="mb-0.5">
                {g.label && (
                  <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.label}
                  </p>
                )}
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                      o.value === value && "font-medium"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{o.hint}</span>
                    )}
                    {o.value === value && (
                      <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
