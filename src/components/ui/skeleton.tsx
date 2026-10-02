import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A placeholder block in the shape of content that is still on its way. Sized
 * by the caller to match the real thing, so the section keeps its height when
 * the content lands instead of jumping from a one-line spinner to its full size.
 *
 * Filled from `--muted-foreground` rather than `--muted`: on this palette muted
 * is a hair off the background in light mode and the block would vanish.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-muted-foreground/15 motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
