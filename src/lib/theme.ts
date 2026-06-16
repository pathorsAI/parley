import { useEffect } from "react";
import { useStore } from "./store";
import type { AppTheme } from "./types";

function resolveTheme(theme: AppTheme, prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

export function useThemePreference() {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function apply() {
      const resolved = resolveTheme(theme, media.matches);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
    }

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
