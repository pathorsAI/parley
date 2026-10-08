import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A small (i) next to a label whose explanation is only for whoever wants it.
 * Settings used to print every explanation under its control, which made the
 * page read like a manual; the controls already say what they do, so the long
 * "why / how / privacy" text waits behind hover (or keyboard focus) instead.
 */
export function InfoTip({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="block max-w-xs whitespace-pre-line text-left leading-relaxed"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
