import * as React from "react"

import { cn } from "@/lib/utils"

// This box is a fixed min-h-16 that scrolls its own overflow, and the Tailwind
// utility for Chromium's content-based auto-sizing is absent on purpose —
// please don't add it back as a nicety. It is Chromium 123+ only and WebKit
// doesn't implement it, so it auto-grew every textarea in the app on Windows
// while macOS kept the fixed height. The layouts around these — the resizable
// panel rails, the Sheet footer, the Ask panel — were all measured against the
// fixed height, so the growing variant was the untested branch: it can
// overflow a rail or push a footer offscreen. Auto-grow is a design decision,
// not a fallback, so a JS shim doesn't belong in the shared primitive either.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
