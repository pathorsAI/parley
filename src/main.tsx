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
const window_ = route.startsWith("settings")
  ? "settings"
  : route.startsWith("finding-solution")
    ? "finding-solution"
    : route.startsWith("diagnostics")
      ? "diagnostics"
      : "main";
log.info("ui: boot", { window: window_ });

const SettingsApp = lazy(() =>
  import("./settings/SettingsApp").then((module) => ({ default: module.SettingsApp }))
);
const FindingSolutionApp = lazy(() =>
  import("./finding-solution/FindingSolutionApp").then((module) => ({ default: module.FindingSolutionApp }))
);
const DiagnosticsApp = lazy(() =>
  import("./diagnostics/DiagnosticsApp").then((module) => ({ default: module.DiagnosticsApp }))
);

function Root() {
  switch (window_) {
    case "settings":
      return <SettingsApp />;
    case "finding-solution":
      return <FindingSolutionApp />;
    case "diagnostics":
      return <DiagnosticsApp />;
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
