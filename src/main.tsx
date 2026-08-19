import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { attachConsoleOnce, log } from "./lib/log";
import { initFolderRegistry } from "./lib/history/folders";
import { desktopPlatform } from "./lib/platform";
import { initZoomShortcuts } from "./lib/zoom";

// Mirror webview console.* into the rotating log file (no-op outside Tauri).
void attachConsoleOnce();

// ⌘/Ctrl + / − / 0 page zoom, per window, persisted across launches.
initZoomShortcuts();

// Hydrate the shared folder registry (disk-backed; see history/folders.ts).
// Every window needs it: History (grid + sidebar), Settings + main titlebar
// (SaveDestinationPicker), replay (folder chip).
void initFolderRegistry().catch((error) =>
  log.warn("folders: registry init failed", { error: String(error) })
);

// Secondary windows load the same bundle at a `#<route>` hash; main.tsx routes
// each to its own root component (Settings / Field Log / How-to-reply).
const route = window.location.hash.replace(/^#/, "");
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
    </Suspense>
  </React.StrictMode>,
);
