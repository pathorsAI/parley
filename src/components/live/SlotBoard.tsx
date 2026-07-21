import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared board primitives (C integration): every scenario renders the same
 * one-line-per-slot model — ScenarioBoard composes these for builtin and
 * custom scenarios alike.
 */

/** The counter-the-challenge banner: outranks gap-chasing, one at a time. */
export function FocusBanner({
  label,
  question,
  reason,
}: Readonly<{ label: string; question: string; reason: string }>) {
  return (
    <div className="rounded-r-md border-l-2 border-primary bg-primary/10 px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">{label}</p>
      <p className="text-xs leading-snug">{question}</p>
      <p className="text-[10px] leading-snug text-muted-foreground">{reason}</p>
    </div>
  );
}

function rowClass(opts: { focused: boolean; activated: boolean; clickable: boolean }): string {
  if (opts.focused) return "rounded-r-md border-l-2 border-primary bg-primary/10";
  if (opts.activated) return "rounded-md bg-muted/60";
  if (opts.clickable) return "cursor-pointer rounded-md hover:bg-muted/40";
  return "rounded-md";
}

function dotClass(state: "empty" | "thin" | "solid"): string {
  if (state === "solid") return "bg-emerald-500";
  if (state === "thin") return "bg-amber-500";
  return "border border-muted-foreground/50";
}

/** One glanceable slot line; only the focused/activated row expands (S22). */
export function SlotRow({
  state,
  label,
  content,
  count,
  focused = false,
  activated = false,
  clickable = false,
  busy = false,
  onActivate,
  children,
}: Readonly<{
  state: "empty" | "thin" | "solid";
  label: string;
  content: string;
  count: number;
  focused?: boolean;
  activated?: boolean;
  clickable?: boolean;
  busy?: boolean;
  onActivate?: () => void;
  children?: ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className={`w-full px-1.5 py-1 text-left transition-colors ${rowClass({ focused, activated, clickable })}`}
    >
      <div className="flex items-baseline gap-1.5">
        <span className={`size-1.5 shrink-0 self-center rounded-full ${dotClass(state)}`} />
        <span className={`shrink-0 text-xs font-medium ${focused ? "text-primary" : ""}`}>
          {label}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            count > 0 ? "text-muted-foreground" : "text-muted-foreground/60"
          }`}
        >
          {content}
        </span>
        {busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          count > 0 && <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>
        )}
      </div>
      {children}
    </button>
  );
}
