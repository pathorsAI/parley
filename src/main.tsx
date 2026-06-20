import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { attachConsoleOnce, log } from "./lib/log";

// Mirror webview console.* into the rotating log file (no-op outside Tauri).
void attachConsoleOnce();

// The settings window loads the same bundle at the `#settings` hash.
const isSettings = window.location.hash.replace(/^#/, "").startsWith("settings");
log.info("ui: boot", { window: isSettings ? "settings" : "main" });
const SettingsApp = lazy(() =>
  import("./settings/SettingsApp").then((module) => ({ default: module.SettingsApp }))
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>{isSettings ? <SettingsApp /> : <App />}</Suspense>
  </React.StrictMode>,
);
