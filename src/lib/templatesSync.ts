import { useStore } from "./store";
import { isTauri } from "./tauriEvents";
import { reconcileTemplates } from "./templates";
import { buildPresetEvalTemplates } from "./evaluations/presets";
import { buildPresetTodoTemplates } from "./todoTemplates";
import { translate, type TranslationKey } from "../i18n/messages";
import type { EvalTemplate, TodoTemplate } from "./types";
import * as ipc from "./ipc/commands";
import { subscribeDebounced } from "./store/subscribe";

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

// Guards against a load → store-change → save echo writing the file right back.
let applyingFromFile = false;

async function loadFromFile(): Promise<void> {
  try {
    const raw = await ipc.readTemplates();
    if (!raw.trim()) {
      await saveToFile(); // seed the file from current (preset) templates
      return;
    }
    const data = JSON.parse(raw) as TemplatesFile;
    // Always fold in the latest built-in templates (so new presets ship to
    // existing users), keeping any custom templates from the file. Built-ins are
    // resolved into the current UI language.
    const t = (key: TranslationKey) => translate(useStore.getState().settings.language, key);
    const patch = {
      evalTemplates: reconcileTemplates(
        buildPresetEvalTemplates(t),
        Array.isArray(data.evalTemplates) ? data.evalTemplates : []
      ),
      todoTemplates: reconcileTemplates(
        buildPresetTodoTemplates(t),
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
    await ipc.writeTemplates({
      json: JSON.stringify({ evalTemplates, todoTemplates }, null, 2),
    });
  } catch (e) {
    console.error("[templates] save failed", e);
  }
}

/** Wire up template ↔ file sync. Call once at app start; returns a teardown. */
export function initTemplatesSync(): () => void {
  if (!isTauri()) return () => {};

  void loadFromFile();

  // Save 400 ms after either template list changes — unless the change is the
  // load above landing (no echo back to the file). A save still pending at
  // teardown lands anyway, so a last edit is never lost.
  const unsub = subscribeDebounced(
    (state) => [state.settings.evalTemplates, state.settings.todoTemplates] as const,
    400,
    saveToFile,
    {
      equals: (a, b) => a[0] === b[0] && a[1] === b[1],
      skip: () => applyingFromFile,
      cancelOnStop: false,
    },
  );

  // Pick up edits made by the MCP server while the app was unfocused.
  const onFocus = () => void loadFromFile();
  window.addEventListener("focus", onFocus);

  return () => {
    unsub();
    window.removeEventListener("focus", onFocus);
  };
}
