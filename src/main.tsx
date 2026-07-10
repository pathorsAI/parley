import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { attachConsoleOnce, log } from "./lib/log";

// Mirror webview console.* into the rotating log file (no-op outside Tauri).
void attachConsoleOnce();

// Secondary windows load the same bundle at a `#<route>` hash; main.tsx routes
// each to its own root component (Settings / Field Log / How-to-reply).
const route = window.location.hash.replace(/^#/, "");
const ROUTES = [
  "settings",
  "finding-solution",
  "diagnostics",
  "history",
  "voice-typing",
  "live-translate",
  "interpreter",
] as const;
const window_ = ROUTES.find((r) => route.startsWith(r)) ?? "main";
log.info("ui: boot", { window: window_ });

// Scope window-chrome CSS to the right surface: only the main window is
// undecorated + transparent (rounded macOS-style corners); the secondary
// windows keep native decorations and an opaque background.
document.documentElement.dataset.appWindow = window_;

const SettingsApp = lazy(() =>
  import("./settings/SettingsApp").then((module) => ({ default: module.SettingsApp }))
);
const FindingSolutionApp = lazy(() =>
  import("./finding-solution/FindingSolutionApp").then((module) => ({ default: module.FindingSolutionApp }))
);
const DiagnosticsApp = lazy(() =>
  import("./diagnostics/DiagnosticsApp").then((module) => ({ default: module.DiagnosticsApp }))
);
const HistoryApp = lazy(() =>
  import("./history/HistoryApp").then((module) => ({ default: module.HistoryApp }))
);
const VoiceTypingApp = lazy(() =>
  import("./voice-typing/VoiceTypingApp").then((module) => ({ default: module.VoiceTypingApp }))
);
const LiveTranslateApp = lazy(() =>
  import("./live-translate/LiveTranslateApp").then((module) => ({ default: module.LiveTranslateApp }))
);
const InterpreterApp = lazy(() =>
  import("./interpreter/InterpreterApp").then((module) => ({ default: module.InterpreterApp }))
);

function Root() {
  switch (window_) {
    case "settings":
      return <SettingsApp />;
    case "finding-solution":
      return <FindingSolutionApp />;
    case "diagnostics":
      return <DiagnosticsApp />;
    case "history":
      return <HistoryApp />;
    case "voice-typing":
      return <VoiceTypingApp />;
    case "live-translate":
      return <LiveTranslateApp />;
    case "interpreter":
      return <InterpreterApp />;
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
