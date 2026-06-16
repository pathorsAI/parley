import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// The settings window loads the same bundle at the `#settings` hash.
const isSettings = window.location.hash.replace(/^#/, "").startsWith("settings");
const SettingsApp = lazy(() =>
  import("./settings/SettingsApp").then((module) => ({ default: module.SettingsApp }))
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>{isSettings ? <SettingsApp /> : <App />}</Suspense>
  </React.StrictMode>,
);
