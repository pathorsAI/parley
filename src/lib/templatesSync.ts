import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import { reconcileTemplates } from "./templates";
import { PRESET_EVAL_TEMPLATES } from "./evaluations/presets";
import { PRESET_TODO_TEMPLATES } from "./todoTemplates";
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
    // Always fold in the latest built-in templates (so new presets ship to
    // existing users), keeping any custom templates from the file.
    const patch = {
      evalTemplates: reconcileTemplates(
        PRESET_EVAL_TEMPLATES,
        Array.isArray(data.evalTemplates) ? data.evalTemplates : []
      ),
      todoTemplates: reconcileTemplates(
        PRESET_TODO_TEMPLATES,
        Array.isArray(data.todoTemplates) ? data.todoTemplates : []
      ),
    };
    applyingFromFile = true;
    useStore.getState().updateSettings(patch);
    applyingFromFile = false;
    // Persist the reconciled set back so the file gains the new built-ins.
    await saveToFile();
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
