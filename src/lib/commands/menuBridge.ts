import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { runCommand } from "./bind";
import { COMMANDS, type CommandId } from "./registry";

/**
 * The macOS menu bar's way back into the command table.
 *
 * On macOS a chord the menu bar claims never reaches the webview — AppKit
 * matches the NSMenu key equivalent first — so for those commands this listener
 * is not a convenience, it is the only path. `bindableChords()` in ./bind.ts is
 * the other half of that deal: it refuses to bind anything with a `native`
 * accelerator on macOS, so exactly one of the two fires.
 *
 * Rust decides WHICH window hears the event (see src-tauri/src/menu.rs) — global
 * commands go to the focused window, main-scope ones to the main window — so
 * there is nothing to route here. The payload is the bare command id.
 */
const MENU_COMMAND = "menu://command";

/** Ids the table actually knows, so a stale menu item can't reach `runCommand`
 *  with something that isn't a command at all. */
const KNOWN_IDS: ReadonlySet<string> = new Set(COMMANDS.map((c) => c.id));

/**
 * Start listening for menu-bar command clicks. Call once per window, at boot —
 * every window installs the global commands, and any of them can be the focused
 * one when ⌘, or ⌘= is chosen from the menu. No-op outside Tauri.
 */
export function initMenuCommands(): void {
  if (!isTauri()) return;
  void listen<string>(MENU_COMMAND, (event) => {
    const id = event.payload;
    if (!KNOWN_IDS.has(id)) {
      log.warn("menu: unknown command", { id });
      return;
    }
    runCommand(id as CommandId);
  }).catch((error) => log.warn("menu: command listener failed", { error: String(error) }));
}
