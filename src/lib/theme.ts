import { useEffect } from "react";
import { useStore } from "./store";
import { log } from "./log";
import { isTauri } from "./platform";
import type { AppTheme } from "./types";

function resolveTheme(theme: AppTheme, prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/**
 * Hand the resolved theme to the OS as well as to the document.
 *
 * The secondary windows (settings, diagnostics, finding-solution) are created
 * WITH native decorations, so their caption bar is drawn by the window manager
 * and follows the OS theme unless we say otherwise. With Parley set to Dark on a
 * light Windows that produced a white caption bar over a near-black body — far
 * louder than the same mismatch on macOS, where the two themes at least share a
 * neutral titlebar.
 *
 * Applied to the CURRENT window, so every window themes its own chrome as it
 * boots; on macOS and Linux Tauri makes this app-wide rather than per-window,
 * which is harmless — the value is the same in every window either way.
 */
function applyNativeTheme(resolved: "light" | "dark") {
  if (!isTauri()) return;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTheme(resolved);
    } catch (error) {
      // Non-fatal: the body is already themed by the class below, so the worst
      // case is the mismatch we started with.
      log.warn("theme: native window theme failed", { error: String(error) });
    }
  })();
}

export function useThemePreference() {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");

    function apply() {
      const resolved = resolveTheme(theme, media.matches);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
      // Inside `apply` rather than beside it so the native chrome follows the
      // SAME two triggers the document already does: the setting changing, and
      // — while the setting is "system" — the OS flipping under us.
      applyNativeTheme(resolved);
    }

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
