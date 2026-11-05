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
async function setNativeTheme(theme: "light" | "dark" | null): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(theme);
  } catch (error) {
    // Non-fatal: the body is already themed by the class, so the worst case is
    // the mismatch we started with.
    log.warn("theme: native window theme failed", { error: String(error) });
  }
}

/** Two frames: long enough for WebKit to re-evaluate prefers-color-scheme
 *  after the window's appearance changes. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export function useThemePreference() {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
    let cancelled = false;
    let syncing = false;

    function paint(resolved: "light" | "dark") {
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
    }

    // The window is always PINNED to the theme the page shows: on macOS the
    // translucent sidebar sits on the window's vibrancy, which follows the
    // window's appearance, and a light window under the dark theme turns the
    // rail grey. But a pinned window is also what the webview then reports as
    // prefers-color-scheme, so for "system" the OS can't be read off the media
    // query directly — after choosing Dark it kept saying dark. System
    // therefore releases the window (null), lets WebKit re-read the OS, takes
    // that answer, and pins it.
    async function sync() {
      if (syncing) return;
      syncing = true;
      try {
        if (theme !== "system") {
          paint(theme);
          await setNativeTheme(theme);
          return;
        }
        await setNativeTheme(null);
        await nextFrames();
        if (cancelled) return;
        const resolved = resolveTheme(theme, media.matches);
        paint(resolved);
        await setNativeTheme(resolved);
      } finally {
        syncing = false;
      }
    }

    void sync();
    // While pinned, the OS flipping is invisible to the media query, so
    // "system" re-checks whenever the window comes back to the front.
    const recheck = () => {
      if (theme === "system") void sync();
    };
    media.addEventListener("change", recheck);
    globalThis.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      media.removeEventListener("change", recheck);
      globalThis.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [theme]);
}
