import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";

/**
 * App-themed Sonner toaster (shadcn's recommended toast). Mounted once in App.
 * Themed from the app's own theme setting rather than next-themes. Errors are
 * shown with the real message + (optionally) a Retry action; see usage with
 * `toast.error(msg, { action: { label, onClick } })`.
 *
 * Every kind sits on the same popover surface (white in light mode) — no
 * green / red fills (Sonner's richColors). The kind still shows, as the
 * icon's colour.
 */
export function Toaster(props: ToasterProps) {
  const theme = useStore((s) => s.settings.theme); // "light" | "dark" | "system"
  const { t } = useI18n();
  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      closeButton
      // Sonner's default region label is English ("Notifications"); it appends
      // the hotkey itself, so this is only the name.
      containerAriaLabel={t("toast.region")}
      className="toaster group"
      toastOptions={{
        classNames: {
          success: "[&_[data-icon]]:text-emerald-600 dark:[&_[data-icon]]:text-emerald-400",
          error: "[&_[data-icon]]:text-destructive",
          warning: "[&_[data-icon]]:text-amber-500",
          info: "[&_[data-icon]]:text-primary",
        },
      }}
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
