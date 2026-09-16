import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { attachConsoleOnce, log } from "./lib/log";
import { initFolderRegistry } from "./lib/history/folders";
import { initDictionary } from "./lib/dictionary";
import { desktopPlatform, isTauri } from "./lib/platform";
import { useStore } from "./lib/store";
import type { AppLanguage } from "./lib/types";
import { restoreZoom } from "./lib/zoom";
import { installGlobalCommands } from "./lib/commands/bind";
import { initMenuCommands } from "./lib/commands/menuBridge";
import { ShortcutSheet } from "./components/shell/ShortcutSheet";

// Mirror webview console.* into the rotating log file (no-op outside Tauri).
void attachConsoleOnce();

// Re-apply this window's saved page zoom (the KEYS are commands now — below).
restoreZoom();

// The window-wide chords — ⌘, ⇧? and page zoom — from lib/commands/registry.ts.
// Installed here rather than from a component because the secondary windows
// (Settings, Field Log, the voice-typing overlay) render no shell to hang a
// hook on, and a Settings window where ⌘, does nothing reads as broken.
installGlobalCommands();

// …and the other end of the same table: on macOS the menu bar owns some of
// those chords outright (AppKit matches them before the webview sees them), so
// the menu item has to be able to run the command. See commands/menuBridge.ts.
initMenuCommands();

// Hydrate the shared folder registry (disk-backed; see history/folders.ts).
// Every window needs it: History (grid + sidebar), Settings + main titlebar
// (SaveDestinationPicker), replay (folder chip).
void initFolderRegistry().catch((error) =>
  log.warn("folders: registry init failed", { error: String(error) })
);

// Hydrate the phrase dictionary (disk-backed; see lib/dictionary). Every window
// needs it: the main window rewrites dictated text before it's pasted, the
// voice-typing overlay rewrites what it displays, Settings edits the list.
void initDictionary().catch((error) =>
  log.warn("dictionary: init failed", { error: String(error) })
);

// Secondary windows load the same bundle at a `#<route>` hash; main.tsx routes
// each to its own root component (Settings / Field Log / How-to-reply).
const route = globalThis.location.hash.replace(/^#/, "");
// `history` is deliberately NOT here: the recordings library is a route inside
// the main window's shell now (#195), not a window of its own.
const ROUTES = [
  "settings",
  "finding-solution",
  "diagnostics",
  "voice-typing",
] as const;
const window_ = ROUTES.find((r) => route.startsWith(r)) ?? "main";
log.info("ui: boot", { window: window_ });

// Scope window-chrome CSS to the right surface: only the main window is
// undecorated + transparent (rounded macOS-style corners); the secondary
// windows keep native decorations and an opaque background.
document.documentElement.dataset.appWindow = window_;
// And to the right OS: the transparent/rounded chrome is macOS-only — the
// Windows main window is undecorated but opaque (see tauri.windows.conf.json).
document.documentElement.dataset.platform = desktopPlatform();

/**
 * BCP-47 tag for the UI language. `zh-Hant-TW`, never a bare `zh`: the script
 * subtag is what actually steers the webview's Han font fallback to
 * Traditional forms, and without it Chromium/WebView2 answers a Chinese string
 * with a Simplified or Japanese face. See --font-sans in index.css for the
 * other half — the explicit families and the tag fix different halves of the
 * same problem, so neither replaces the other.
 */
function langTagOf(language: AppLanguage): string {
  return language === "en" ? "en" : "zh-Hant-TW";
}

function applyLangTag(language: AppLanguage): void {
  document.documentElement.lang = langTagOf(language);
}

applyLangTag(useStore.getState().settings.language);
// The boot value is not enough: the switcher lives in the Settings *window*,
// so every other window learns about a language change through settingsSync,
// with no reload to re-read index.html. Subscribed straight off the store the
// way theme.ts watches its setting — as a subscription rather than a hook,
// because the secondary windows render no shared shell to hang one on (same
// reason as installGlobalCommands above).
useStore.subscribe((state, previous) => {
  if (state.settings.language !== previous.settings.language) {
    applyLangTag(state.settings.language);
  }
});

// WebView2 hands out Edge's own context menu — Back / Reload / Save as… /
// Print… / Inspect — anywhere the app doesn't claim the event. "Reload"
// mid-meeting reloads the webview and takes a running recording with it, so
// suppress the menu where we have nothing of our own to offer. WKWebView's
// menu is far thinner, which is why this only ever showed up on Windows.
//
// Two carve-outs, both about not stealing something the user needs: editable
// text keeps the webview's cut/copy/paste menu (the sidebar's rename input
// already stopPropagation()s for exactly this reason — see AppSidebar.tsx),
// and so does a live selection, where copy is the only thing on offer. This
// listens on the bubble phase at the window, so anything that stopped
// propagation on the way up — Radix's ContextMenu triggers, those inputs —
// never reaches it and keeps its own behaviour. Tauri-only, so `bun run dev`
// in a browser keeps its devtools menu.
if (isTauri()) {
  globalThis.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
    ) {
      return;
    }
    const selection = globalThis.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    event.preventDefault();
  });
}

const SettingsApp = lazy(() =>
  import("./settings/SettingsApp").then((module) => ({ default: module.SettingsApp }))
);
const FindingSolutionApp = lazy(() =>
  import("./finding-solution/FindingSolutionApp").then((module) => ({ default: module.FindingSolutionApp }))
);
const DiagnosticsApp = lazy(() =>
  import("./diagnostics/DiagnosticsApp").then((module) => ({ default: module.DiagnosticsApp }))
);
const VoiceTypingApp = lazy(() =>
  import("./voice-typing/VoiceTypingApp").then((module) => ({ default: module.VoiceTypingApp }))
);

function Root() {
  switch (window_) {
    case "settings":
      return <SettingsApp />;
    case "finding-solution":
      return <FindingSolutionApp />;
    case "diagnostics":
      return <DiagnosticsApp />;
    case "voice-typing":
      return <VoiceTypingApp />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
      {/* ⇧? in every window that is big enough to read it. The voice-typing
          overlay is a transient always-on-top strip — a cheat sheet there would
          have nowhere to go. */}
      {window_ !== "voice-typing" && <ShortcutSheet />}
    </Suspense>
  </React.StrictMode>,
);
