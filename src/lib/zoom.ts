import { isTauri } from "./tauriEvents";
import { log } from "./log";

/**
 * Webview zoom on ⌘+/⌘−/⌘0 (every Parley window, persisted). WKWebView has no
 * built-in page-zoom shortcut, so we drive Tauri's setZoom ourselves.
 */

const KEY = "parley:zoom";
const MIN = 0.6;
const MAX = 1.8;
const STEP = 0.1;

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 10) / 10));
}

async function apply(zoom: number): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(zoom);
}

/** Install the shortcut listener and re-apply the saved zoom. Idempotent-ish
 *  (call once per window, from main.tsx). No-op in the browser. */
export function initZoomShortcuts(): void {
  if (!isTauri()) return;

  let zoom = clamp(Number.parseFloat(localStorage.getItem(KEY) ?? "1") || 1);
  if (zoom !== 1) {
    apply(zoom).catch((e) => log.warn("zoom: restore failed", { error: String(e) }));
  }

  window.addEventListener("keydown", (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") zoom = clamp(zoom + STEP);
    else if (e.key === "-") zoom = clamp(zoom - STEP);
    else if (e.key === "0") zoom = 1;
    else return;
    e.preventDefault();
    localStorage.setItem(KEY, String(zoom));
    apply(zoom).catch((e) => log.warn("zoom: apply failed", { error: String(e) }));
  });
}
