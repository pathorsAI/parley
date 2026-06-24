import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useStore } from "../../lib/store";

/**
 * App-themed Sonner toaster (shadcn's recommended toast). Mounted once in App.
 * Themed from the app's own theme setting rather than next-themes. Errors are
 * shown with the real message + (optionally) a Retry action; see usage with
 * `toast.error(msg, { action: { label, onClick } })`.
 */
export function Toaster(props: ToasterProps) {
  const theme = useStore((s) => s.settings.theme); // "light" | "dark" | "system"
  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      richColors
      closeButton
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}
