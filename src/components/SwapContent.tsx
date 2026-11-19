import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Content that changes in place — a button going from "Sign in" to
 * "Signing in…" and back — without snapping. Every state is laid out in the
 * same grid cell, so the box is always as wide and tall as the largest one
 * (the button around it never jumps), and only the active one is visible,
 * cross-fading over 200 ms. The hidden ones are aria-hidden, so a screen
 * reader hears only the current state.
 */
export function SwapContent<K extends string>({
  active,
  states,
  className,
}: Readonly<{
  active: K;
  states: Record<K, ReactNode>;
  className?: string;
}>) {
  return (
    <span className={cn("inline-grid", className)}>
      {(Object.keys(states) as K[]).map((key) => (
        <span
          key={key}
          aria-hidden={key !== active}
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center justify-center gap-2 transition-opacity duration-200 ease-out motion-reduce:transition-none",
            key === active ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {states[key]}
        </span>
      ))}
    </span>
  );
}
