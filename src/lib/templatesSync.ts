import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import type { EvalTemplate, TodoTemplate } from "./types";

/**
 * Sync eval/TODO templates with a shared on-disk JSON file
 * (`<appConfigDir>/templates.json`) that a local MCP server also reads/writes.
 * The file is the source of truth: we load it on startup and on window focus,
 * and write it back whenever the templates change in the app.
 */
interface TemplatesFile {
  evalTemplates?: EvalTemplate[];
  todoTemplates?: TodoTemplate[];
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Guards against a load → store-change → save echo writing the file right back.
let applyingFromFile = false;

async function loadFromFile(): Promise<void> {
  try {
    const raw = await invoke<string>("read_templates");
    if (!raw.trim()) {
      await saveToFile(); // seed the file from current (preset) templates
      return;
    }
    const data = JSON.parse(raw) as TemplatesFile;
    const patch: Partial<{ evalTemplates: EvalTemplate[]; todoTemplates: TodoTemplate[] }> = {};
    if (Array.isArray(data.evalTemplates)) patch.evalTemplates = data.evalTemplates;
    if (Array.isArray(data.todoTemplates)) patch.todoTemplates = data.todoTemplates;
    if (Object.keys(patch).length) {
      applyingFromFile = true;
      useStore.getState().updateSettings(patch);
      applyingFromFile = false;
    }
  } catch (e) {
    console.error("[templates] load failed", e);
  }
}

async function saveToFile(): Promise<void> {
  const { evalTemplates, todoTemplates } = useStore.getState().settings;
  try {
    await invoke("write_templates", {
      json: JSON.stringify({ evalTemplates, todoTemplates }, null, 2),
    });
  } catch (e) {
    console.error("[templates] save failed", e);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveToFile(), 400);
}

/** Wire up template ↔ file sync. Call once at app start; returns a teardown. */
export function initTemplatesSync(): () => void {
  if (!isTauri()) return () => {};

  void loadFromFile();

  let lastEval = useStore.getState().settings.evalTemplates;
  let lastTodo = useStore.getState().settings.todoTemplates;
  const unsub = useStore.subscribe((state) => {
    const e = state.settings.evalTemplates;
    const t = state.settings.todoTemplates;
    if (e !== lastEval || t !== lastTodo) {
      lastEval = e;
      lastTodo = t;
      if (!applyingFromFile) scheduleSave();
    }
  });

  // Pick up edits made by the MCP server while the app was unfocused.
  const onFocus = () => void loadFromFile();
  window.addEventListener("focus", onFocus);

  return () => {
    unsub();
    window.removeEventListener("focus", onFocus);
  };
}
