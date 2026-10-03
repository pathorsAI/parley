// Launch at login (Settings › Basic). The OS is the source of truth — the
// login item can be changed behind Parley's back (Task Manager › Startup apps,
// a removed LaunchAgent, a reinstall), and the value is per device — so there
// is deliberately no Settings field for it: the toggle asks Rust every time it
// is shown. Rust owns the login item (src-tauri/src/autostart.rs); the
// autostart plugin's own JS commands are not granted to the webview.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";
import { log } from "./log";

/**
 * What `set_launch_at_login` rejects with when macOS runs Parley from a
 * Gatekeeper-translocated copy (opened from Downloads or a disk image): that
 * path vanishes once the app quits, so a login item pointing at it would never
 * fire. Matches `TRANSLOCATED_ERROR` in src-tauri/src/autostart.rs.
 */
export const LAUNCH_AT_LOGIN_TRANSLOCATED = "translocated";

/** OS answer; null outside Tauri or when the query failed (the toggle then renders disabled rather than lying). */
export async function launchAtLoginStatus(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<boolean>("launch_at_login_status");
  } catch (error) {
    log.warn("autostart: status check failed", { error: String(error) });
    return null;
  }
}

/** Resolves to the OS state AFTER the change (Rust re-reads it); rejects when the OS did not take it. */
export function setLaunchAtLogin(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_launch_at_login", { enabled });
}

/** Whether a `setLaunchAtLogin` rejection is the translocated-app refusal. */
export function isTranslocatedError(error: unknown): boolean {
  return String(error) === LAUNCH_AT_LOGIN_TRANSLOCATED;
}
