import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Side sheet — the app's editing surface. Editing flows (meeting context, the
 * accounts drill-in during a live call) keep the main screen visible beside
 * them, which a centered modal cannot do.
 *
 * The main window's titlebar has `backdrop-blur`, which makes it the containing
 * block for fixed-position descendants; Radix portals to `document.body`, so a
 * sheet opened from the titlebar still covers the viewport.
 */

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
  className,
  children,
  footer,
  side = "right",
  title,
  description,
  closeLabel,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "right" | "left";
  /** Rendered as the sheet header; also the accessible dialog title. */
  title: string;
  description?: string;
  closeLabel: string;
  /** Action row pinned below the scroll area (Save / Done / Copy). */
  footer?: React.ReactNode;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-[90] bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-[91] flex w-full max-w-md flex-col border-l bg-background shadow-xl transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=open]:animate-in",
          side === "right"
            ? "right-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
            : "left-0 border-l-0 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
          className
        )}
        {...props}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <SheetPrimitive.Title className="truncate text-sm font-semibold">
              {title}
            </SheetPrimitive.Title>
            {description ? (
              <SheetPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </SheetPrimitive.Description>
            ) : (
              <SheetPrimitive.Description className="sr-only">{title}</SheetPrimitive.Description>
            )}
          </div>
          <SheetPrimitive.Close
            aria-label={closeLabel}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </SheetPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

/** Sticky action row at the bottom of a sheet. */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3", className)}
      {...props}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetFooter };
