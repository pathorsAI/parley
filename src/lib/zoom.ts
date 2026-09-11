import { isTauri } from "./tauriEvents";
import { log } from "./log";

/**
 * Webview zoom, per window, persisted across launches. WKWebView has no
 * built-in page-zoom shortcut, so Parley drives Tauri's setZoom itself.
 *
 * The KEYS used to live here, in a bare `keydown` listener that predated the
 * shortcut registry. They now live in lib/commands/registry.ts with every other
 * chord — this module is just the three verbs and the persistence.
 */

const KEY = "parley:zoom";
const MIN = 0.6;
const MAX = 1.8;
const STEP = 0.1;

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 10) / 10));
}

let zoom = 1;

async function apply(next: number): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(next);
}

function set(next: number): void {
  if (!isTauri()) return;
  zoom = clamp(next);
  localStorage.setItem(KEY, String(zoom));
  apply(zoom).catch((e) => log.warn("zoom: apply failed", { error: String(e) }));
}

export function zoomIn(): void {
  set(zoom + STEP);
}

export function zoomOut(): void {
  set(zoom - STEP);
}

export function zoomReset(): void {
  set(1);
}

/** Re-apply the zoom this window was left at. Call once per window, from
 *  main.tsx, before React mounts. No-op in the browser. */
export function restoreZoom(): void {
  if (!isTauri()) return;
  zoom = clamp(Number.parseFloat(localStorage.getItem(KEY) ?? "1") || 1);
  if (zoom === 1) return;
  apply(zoom).catch((e) => log.warn("zoom: restore failed", { error: String(e) }));
}
