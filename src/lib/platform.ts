import { platform as tauriPlatform } from "@tauri-apps/plugin-os";

/**
 * Are we inside the Tauri webview (as opposed to `bun run dev` in a browser, or
 * the unit suite in plain Node)?
 *
 * This lives HERE, not in tauriEvents, because tauriEvents reaches the store,
 * the i18n dictionary and the toast layer — and store.ts now asks the platform
 * a question at module scope (the voice-typing default shortcut). Routing that
 * one-line globalThis check through tauriEvents would close an import cycle
 * store → platform → tauriEvents → store. tauriEvents re-exports it, so every
 * existing `import { isTauri } from "./tauriEvents"` keeps working.
 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/**
 * Which desktop OS the app is running on. Inside Tauri this is authoritative
 * (tauri-plugin-os); in plain-browser dev it falls back to a user-agent sniff
 * so `bun run dev` keeps behaving like the host OS. Every UI platform branch
 * goes through here — never sniff `navigator.userAgent` at a call site.
 */
export type DesktopPlatform = "macos" | "windows" | "linux";

let cached: DesktopPlatform | undefined;

export function desktopPlatform(): DesktopPlatform {
  if (cached) return cached;
  if (isTauri()) {
    const p = tauriPlatform();
    cached = p === "macos" || p === "windows" ? p : "linux";
    return cached;
  }
  // Optional chaining, not a bare `navigator`: modules that decide a default at
  // import time (store.ts picks the voice-typing shortcut per platform) are
  // also imported by the unit suite, which runs in a plain Node environment
  // where `navigator` may not exist at all. A throw there would fail the whole
  // test file for a value it never looks at.
  const ua = globalThis.navigator?.userAgent ?? "";
  if (ua.includes("Mac")) {
    cached = "macos";
  } else if (ua.includes("Windows")) {
    cached = "windows";
  } else {
    cached = "linux";
  }
  return cached;
}

export const isMac = (): boolean => desktopPlatform() === "macos";
export const isWindows = (): boolean => desktopPlatform() === "windows";
