import { platform as tauriPlatform } from "@tauri-apps/plugin-os";
import { isTauri } from "./tauriEvents";

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
  } else if (navigator.userAgent.includes("Mac")) {
    cached = "macos";
  } else if (navigator.userAgent.includes("Windows")) {
    cached = "windows";
  } else {
    cached = "linux";
  }
  return cached;
}

export const isMac = (): boolean => desktopPlatform() === "macos";
export const isWindows = (): boolean => desktopPlatform() === "windows";
