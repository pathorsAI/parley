// The user's settings (persisted), the active evaluations derived from them,
// and the Settings-window broadcast every edit made there goes out through.

import type { Evaluation, Settings } from "../types";
import { buildPresetEvalTemplates, evalsFromDefs } from "../evaluations/presets";
import { reconcileTemplates } from "../templates";
import { buildPresetTodoTemplates } from "../todoTemplates";
import { log } from "../log";
import { DEFAULT_SETTINGS, tFor } from "./defaults";
import { relabelBuiltinEvals } from "./persistence";
import type { SliceCreator } from "./types";

export interface SettingsSlice {
  evaluations: Evaluation[];
  settings: Settings;
  /** Apply a settings edit. In the window that owns editing (Settings — see
   *  {@link setSettingsBroadcaster}) the result is also broadcast to every
   *  other window, right after it lands. */
  updateSettings: (patch: Partial<Settings>) => void;
  /** Replace settings wholesale — used to sync from the settings window. Never
   *  broadcasts, so a received update can't echo back. */
  applySettings: (settings: Settings) => void;
}

/**
 * Re-resolve all built-in template content (eval templates, TODO templates, and
 * the labels of any active built-in evaluations) into `settings.language`,
 * keeping the user's own custom templates. Called whenever the language changes
 * so built-in content follows the UI language. Custom templates and custom
 * evaluations (ids not in the built-in set) are left untouched.
 */
function relocalizeBuiltins(settings: Settings): Settings {
  const t = tFor(settings.language);
  return {
    ...settings,
    evalTemplates: reconcileTemplates(buildPresetEvalTemplates(t), settings.evalTemplates),
    todoTemplates: reconcileTemplates(buildPresetTodoTemplates(t), settings.todoTemplates),
    evaluations: relabelBuiltinEvals(settings.evaluations, settings.language),
  };
}

// ── Settings-window broadcast ─────────────────────────────────────────────────
//
// Only the Settings window broadcasts: it is where settings are edited, and the
// other windows apply what it sends (settingsSync.listenForSettings →
// applySettings, which never broadcasts). The transport is injected so the
// store itself does no IPC; settingsSync installs it in the Settings window.

type SettingsBroadcaster = (settings: Settings) => Promise<void>;

let broadcaster: SettingsBroadcaster | null = null;
let lastBroadcast: Promise<void> = Promise.resolve();

/** Make every `updateSettings` in THIS window broadcast its result (null stops). */
export function setSettingsBroadcaster(fn: SettingsBroadcaster | null): void {
  broadcaster = fn;
}

/** Resolves once the latest broadcast has gone out (or failed, which is logged).
 *  For a hand-off that closes this window right after an edit. */
export function settingsBroadcastSettled(): Promise<void> {
  return lastBroadcast;
}

function broadcast(settings: Settings): void {
  if (!broadcaster) return;
  lastBroadcast = broadcaster({ ...settings }).catch((error) =>
    log.warn("settings: broadcast failed", { error: String(error) }),
  );
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  evaluations: evalsFromDefs(DEFAULT_SETTINGS.evaluations),
  settings: DEFAULT_SETTINGS,

  updateSettings: (patch) => {
    set((state) => {
      let settings = { ...state.settings, ...patch };
      // When the UI language changes, re-resolve built-in templates so they
      // follow the new language (this is the onboarding language-switch path).
      if (patch.language && patch.language !== state.settings.language) {
        settings = relocalizeBuiltins(settings);
      }
      return {
        settings,
        evaluations: evalsFromDefs(settings.evaluations, state.evaluations),
      };
    });
    broadcast(get().settings);
  },

  applySettings: (settings) =>
    set((state) => ({
      // Trust the incoming settings: the broadcasting window already re-resolves
      // built-in templates whenever its language changes, so they arrive in the
      // right language (and any user edits are preserved).
      settings,
      evaluations: evalsFromDefs(settings.evaluations, state.evaluations),
    })),
});
