// Screenshot harness entry. Runs BEFORE the real app boots:
//
//  1. seeds localStorage the way a set-up install would have it (language,
//     theme, onboarding done, folders);
//  2. installs Tauri's own IPC mock (@tauri-apps/api/mocks) so the app takes
//     its desktop code paths — the library, history reads, window chrome —
//     with every backend command answered from fictional demo data;
//  3. boots the real `src/main.tsx`;
//  4. drives the store into the requested scene through the same actions the
//     UI calls (startMeeting / upsertSegment / loadHistoryEntry / openLibrary …).
//
// URL: index.html?scene=home|library|live|report&lang=zh|en&theme=light|dark
// When the scene is on screen, `globalThis.__SHOT_READY__` becomes true.
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import * as demo from "./demo-data";

type Scene = "home" | "library" | "live" | "report";

const q = new URLSearchParams(location.search);
const scene = (q.get("scene") ?? "home") as Scene;
const lang: demo.Lang = q.get("lang") === "en" ? "en" : "zh";
const theme = q.get("theme") === "dark" ? "dark" : "light";
const NOW = Date.now();

// Page globals the shooter reads (or calls). `var` so they type on `globalThis`,
// which in the page is the same object as `window`.
declare global {
  var __SHOT_READY__: boolean | undefined;
  var __SHOT_LOG__: string[] | undefined;
  var __TAURI_OS_PLUGIN_INTERNALS__: Record<string, string> | undefined;
  /** Fire a macOS menu-bar command the way the native menu does (⌘K etc.). */
  var __MENU_COMMAND__: ((id: string) => Promise<void>) | undefined;
}
const shotLog: string[] = (globalThis.__SHOT_LOG__ = []);

// ── 1. Seed storage ────────────────────────────────────────────────────────
try {
  localStorage.clear();
  localStorage.setItem(
    "parley-settings",
    JSON.stringify({
      state: {
        settings: {
          language: lang === "en" ? "en" : "zh-TW",
          theme,
          layout: "coach",
          onboarded: true,
          onboardingStep: 99,
          // Placeholder keys so the "no AI key / no STT key" gates stay down —
          // a configured install has them. Nothing is ever sent anywhere: every
          // saved output is restored from the entry, and the shooter blocks all
          // non-local network requests anyway.
          llmProviders: { realtime: "groq", deep: "groq" },
          groqApiKey: "demo-placeholder",
          sonioxApiKey: "demo-placeholder",
        },
        cloudAuth: null,
      },
      version: 3,
    }),
  );
  localStorage.setItem("parley:folders", JSON.stringify(demo.folders(lang)));
  localStorage.setItem("parley.seenReleaseNotesVersion", "0.31.5");
  localStorage.setItem("parley:ax-boot-prompted", "1");
} catch {
  /* storage unavailable — the app falls back to defaults */
}

// ── 2. Tauri IPC mock ──────────────────────────────────────────────────────
globalThis.__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: "macos",
  os_type: "macos",
  family: "unix",
  version: "26.0.0",
  arch: "aarch64",
  eol: "\n",
  exe_extension: "",
};
mockWindows("main");
mockConvertFileSrc("macos");

function handle(cmd: string, args: Record<string, unknown> | undefined): unknown {
  switch (cmd) {
    // history + folders — the demo library
    case "list_history":
      return demo.summaries(lang, NOW).map((s) => JSON.stringify(s));
    case "read_history_entry":
      return { meta: demo.entry(typeof args?.id === "string" ? args.id : "", lang, NOW), audioPath: null };
    case "read_folders":
      return JSON.stringify(demo.folders(lang));
    case "write_folders":
    case "save_history_entry":
    case "write_session":
    case "set_voice_typing_shortcut":
    case "plugin:window|set_theme":
    case "plugin:window|set_focus":
      return null;
    // empty on-disk stores: no custom templates, dictionary or queued MCP commands
    case "read_templates":
    case "read_dictionary":
    case "read_session_commands":
      return "";
    case "accessibility_status":
      return true;
    case "plugin:window|get_all_windows":
      return ["main"];
    // benign writes / window prewarm the harness has nothing to answer for
    case "write_templates":
    case "plugin:webview|create_webview_window":
      return null;
    // window chrome
    case "plugin:window|is_fullscreen":
    case "plugin:window|is_maximized":
      return false;
    case "plugin:window|is_focused":
      return true;
    case "plugin:app|version":
      return "0.31.5";
    case "plugin:log|log":
      return null;
    case "plugin:updater|check":
      return null;
    // MCP indicator: no client connected (the idle state of a fresh launch)
    case "get_mcp_activity":
      return null;
    case "get_mcp_server_info":
      return { endpoint: "http://127.0.0.1:3011/mcp" };
    default:
      shotLog.push(`ipc: ${cmd}`);
      return null;
  }
}
mockIPC((cmd, args) => handle(cmd, args as Record<string, unknown> | undefined), {
  shouldMockEvents: true,
});

globalThis.__MENU_COMMAND__ = (id: string) => emit("menu://command", id);

// ── 3 + 4. Boot the app, then stage the scene ─────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

async function stage(): Promise<void> {
  await import("@repo/main.tsx");
  const { useStore } = await import("@repo/lib/store");
  const st = () => useStore.getState();
  // Let the shell mount and the library tree read its summaries.
  await sleep(300);

  if (scene === "home") {
    st().openHome();
  } else if (scene === "library") {
    st().openLibrary({ kind: "personal", node: { kind: "all" } });
  } else if (scene === "live") {
    // The user picked the sales watcher set for this call (Settings → templates);
    // it is what the transcript rail's timeline names as its template.
    const tpl = st().settings.evalTemplates.find((x) => x.id === "tpl-sales");
    if (tpl) st().updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
    st().startMeeting();
    useStore.setState({ meetingStartedAt: Date.now() - demo.LIVE_ELAPSED_MS + 1000 });
    for (const t of demo.liveTodos(lang)) {
      st().addTodo(t.text);
    }
    const todos = st().todos;
    demo.liveTodos(lang).forEach((t, i) => {
      if (t.done && todos[i]) st().toggleTodo(todos[i].id);
    });
    for (const seg of demo.liveSegments(lang)) st().upsertSegment(seg);
    st().setFindings(demo.liveFindings(lang));
    st().setAnalysisStatus("done");
    // The mic level the backend streams while you talk (the partial line is
    // yours): feed the titlebar LevelMeter through its real event.
    let phase = 0;
    setInterval(() => {
      phase += 1;
      const level = 0.14 + 0.05 * Math.sin(phase / 2) + 0.03 * Math.sin(phase * 1.7);
      emit("audio://level", { source: "me", level }).catch((e: unknown) => {
        shotLog.push(`audio level emit failed: ${String(e)}`);
      });
    }, 90);
  } else if (scene === "report") {
    const { loadHistoryEntry } = await import("@repo/lib/history/history");
    await loadHistoryEntry("rec-northwind");
    st().setStudyTab("report");
  }

  // Fonts (DM Sans / Alexandria are bundled) and the entrance animations.
  await document.fonts.ready;
  await until(() => document.querySelector("#root")?.childElementCount !== 0);
  await sleep(1200);
  globalThis.__SHOT_READY__ = true;
}

// Deliberately not a top-level `await stage()`: Rollup hoists the Tauri API the
// app shares with this harness into this entry chunk, so the app chunks that
// stage() imports import back from a module that would still be evaluating, and
// the build throws a TDZ ReferenceError at boot. Letting this module finish
// evaluating first (a detached promise) is what makes the harness work.
stage().catch((e: unknown) => {
  shotLog.push(`harness error: ${String(e)}`);
  globalThis.__SHOT_READY__ = true;
});
