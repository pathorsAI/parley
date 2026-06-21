// Thin wrapper over @tauri-apps/plugin-log so frontend logs land in the same
// rotating file as the Rust backend. No-op-safe outside Tauri (plain-browser
// dev): falls back to console so logging never throws and never blocks the UI.
//
// Privacy: NEVER pass secrets or content here — no API keys, transcript text,
// question text, or prompt bodies. Log counts, sizes, durations, ids, providers.
import { isTauri } from "./tauriEvents";

type Fields = Record<string, unknown>;

/** Append "key=value" pairs so the flat log file stays greppable. */
function fmt(msg: string, fields?: Fields): string {
  if (!fields) return msg;
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? `${msg} ${parts.join(" ")}` : msg;
}

// Lazy import keeps the plugin out of the non-Tauri bundle path and avoids
// import-time crashes when __TAURI_INTERNALS__ is absent.
type Plugin = typeof import("@tauri-apps/plugin-log");
let pluginPromise: Promise<Plugin | null> | null = null;
function plugin(): Promise<Plugin | null> {
  if (!isTauri()) return Promise.resolve(null);
  if (!pluginPromise) {
    pluginPromise = import("@tauri-apps/plugin-log").catch(() => null);
  }
  return pluginPromise;
}

function emit(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = fmt(msg, fields);
  void plugin().then((p) => {
    if (p) {
      void p[level](line).catch(() => {});
    } else {
      (level === "debug" ? console.debug : console[level])(line);
    }
  });
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

// Call ONCE at app boot. Forwards webview console.* into the log pipeline so
// existing console output is persisted too. No-op outside Tauri.
let consoleAttached = false;
export async function attachConsoleOnce(): Promise<void> {
  if (consoleAttached) return;
  consoleAttached = true;
  const p = await plugin();
  if (!p) return;
  try {
    await p.attachConsole();
  } catch {
    /* never let logging setup break boot */
  }
}
