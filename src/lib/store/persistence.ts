// What the store persists ("parley-settings" in localStorage: settings + the
// cloud sign-in), and how an older saved shape becomes today's on rehydrate.

import type {
  AppLanguage,
  Evaluation,
  EvalDef,
  GettingStartedState,
  HintId,
  LlmProvider,
  ProviderModels,
  ReasoningEffort,
  Settings,
  VoiceTypingPolishStyle,
} from "../types";
import type { CloudAuth } from "../cloud/types";
import { isMac } from "../platform";
import { buildBuiltinEvalLabels, defaultEvalDefs, buildPresetEvalTemplates, evalsFromDefs } from "../evaluations/presets";
import { reconcileTemplates } from "../templates";
import { buildPresetTodoTemplates } from "../todoTemplates";
import {
  ALL_HINT_IDS,
  DEFAULT_GETTING_STARTED,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_TYPING_SHORTCUT,
  tFor,
} from "./defaults";
import type { ParleyState } from "./types";
import type { MeetingDraft } from "./prep";

/**
 * #131: map legacy single-provider settings (provider + {ask,eval} model roles)
 * onto the per-workload lanes. Realtime inherits the old ask model (the faster
 * of the two), deep inherits eval — live gets faster and reports get stronger
 * without user action. Already-migrated shapes pass through untouched.
 * Exported for tests.
 */
export function migrateLlmSettings(
  p: Partial<Settings>
): Pick<Settings, "llmProviders" | "models" | "reasoningEffort"> {
  const legacy = p as Omit<Partial<Settings>, "models" | "reasoningEffort"> & {
    provider?: LlmProvider;
    reasoningEffort?: unknown;
    models?: Record<string, { ask?: string; eval?: string; realtime?: string; deep?: string }>;
  };
  const llmProviders: Settings["llmProviders"] =
    p.llmProviders ??
    (legacy.provider
      ? { realtime: legacy.provider, deep: legacy.provider }
      : DEFAULT_SETTINGS.llmProviders);
  const models: Record<LlmProvider, ProviderModels> = { ...DEFAULT_SETTINGS.models };
  for (const [prov, m] of Object.entries(legacy.models ?? {})) {
    if (!m || !(prov in models)) continue;
    const key = prov as LlmProvider;
    if (typeof m.realtime === "string" && typeof m.deep === "string") {
      models[key] = { realtime: m.realtime, deep: m.deep };
    } else if (typeof m.ask === "string" && typeof m.eval === "string") {
      models[key] = { realtime: m.ask, deep: m.eval };
    }
  }
  const persistedReasoning = legacy.reasoningEffort as
    | string
    | { ask?: ReasoningEffort; eval?: ReasoningEffort; realtime?: ReasoningEffort; deep?: ReasoningEffort }
    | undefined;
  const reasoningEffort: Settings["reasoningEffort"] =
    typeof persistedReasoning === "string"
      ? { realtime: persistedReasoning as ReasoningEffort, deep: persistedReasoning as ReasoningEffort }
      : {
          realtime:
            persistedReasoning?.realtime ?? persistedReasoning?.ask ?? DEFAULT_SETTINGS.reasoningEffort.realtime,
          deep: persistedReasoning?.deep ?? persistedReasoning?.eval ?? DEFAULT_SETTINGS.reasoningEffort.deep,
        };
  return { llmProviders, models, reasoningEffort };
}

/** The trigger ids that only macOS can deliver: `alt-space` (the old universal
 *  default) plus the two modifier keys a PC keyboard doesn't have. Right Ctrl
 *  (`right-control`) and right Alt (`right-option`) are NOT here: Windows
 *  holds those through a low-level keyboard hook (#462). */
const MAC_ONLY_SHORTCUTS: ReadonlySet<string> = new Set(["alt-space", "fn", "right-command"]);

/**
 * Move a Windows install off a trigger it can never fire.
 *
 * Voice typing shipped macOS-only, but `voiceTypingShortcut` was persisted on
 * every platform — so an existing Windows install already has `alt-space`
 * saved, written by the old default. On Windows that chord is the native
 * window system menu, so honouring it would leave upgraders with dictation
 * that silently does nothing. This is safe precisely because it cannot
 * overwrite a real choice: the Settings pane that edits this value was hidden
 * on Windows until now, so no Windows user has ever picked any of these ids —
 * they could only arrive from the old default or from settings synced off a
 * Mac. A combo the user recorded themselves is left alone, and so is right
 * Ctrl / right Alt, which Windows can now hold as well.
 *
 * Exported for tests.
 */
export function migrateVoiceTypingShortcut(
  saved: Settings["voiceTypingShortcut"] | undefined,
): Settings["voiceTypingShortcut"] {
  if (saved === undefined) return DEFAULT_VOICE_TYPING_SHORTCUT;
  if (isMac()) return saved;
  return MAC_ONLY_SHORTCUTS.has(saved) ? DEFAULT_VOICE_TYPING_SHORTCUT : saved;
}

const POLISH_STYLES: readonly VoiceTypingPolishStyle[] = ["off", "tidy", "concise"];

/**
 * The polish style a persisted settings blob amounts to.
 *
 * The on/off `voiceTypingPolish` switch became a three-way style. A recognised
 * `voiceTypingPolishStyle` wins; without one the old switch decides — off stays
 * off, and on (or never set, which defaulted to on) becomes `tidy`, which is
 * exactly what "on" used to do. Mirrors iOS's `PolishStyle.resolve`.
 *
 * Exported for tests.
 */
export function migrateVoiceTypingPolishStyle(saved: {
  voiceTypingPolishStyle?: unknown;
  voiceTypingPolish?: unknown;
}): VoiceTypingPolishStyle {
  const style = saved.voiceTypingPolishStyle;
  if (typeof style === "string" && (POLISH_STYLES as readonly string[]).includes(style)) {
    return style as VoiceTypingPolishStyle;
  }
  return saved.voiceTypingPolish === false ? "off" : "tidy";
}

/** Fold a persisted (possibly partial or malformed) checklist over the defaults. */
function backfillGettingStarted(saved: unknown): GettingStartedState {
  if (!saved || typeof saved !== "object") return { ...DEFAULT_GETTING_STARTED };
  const g = saved as Partial<Record<keyof GettingStartedState, unknown>>;
  const flag = (v: unknown) => v === true;
  return {
    recorded: flag(g.recorded),
    filed: flag(g.filed),
    replayed: flag(g.replayed),
    handedOff: flag(g.handedOff),
    dismissedAt: typeof g.dismissedAt === "number" ? g.dismissedAt : null,
  };
}

/**
 * Relabel built-in evaluations to `language`, keeping any custom (non-built-in
 * id) evaluation exactly as saved. Shared by rehydrate and the language switch.
 */
export function relabelBuiltinEvals<T extends Pick<Evaluation, "id" | "name" | "description">>(
  evals: readonly T[],
  language: AppLanguage,
): T[] {
  const labels = buildBuiltinEvalLabels(tFor(language));
  return evals.map((e) => {
    const label = labels.get(e.id);
    return label ? { ...e, name: label.name, description: label.description } : e;
  });
}

/** Is a persisted template list today's shape: objects carrying an array under `field`? */
function isTemplateList(value: unknown, field: "items" | "evals"): boolean {
  return (
    Array.isArray(value) &&
    value.every((t) => t && typeof t === "object" && Array.isArray((t as Record<string, unknown>)[field]))
  );
}

/** Persist schema version. v4 added `gettingStarted` + `hintsSeen`. */
export const PERSIST_VERSION = 4;

/**
 * zustand-persist `migrate`, run when the stored version differs from
 * {@link PERSIST_VERSION}.
 *
 * - v3 → v4: someone who already finished (or skipped) the old wizard is an
 *   existing user. They must never see the getting-started checklist or the
 *   one-time hints, so both are pre-closed. New users (onboarded false or
 *   missing) keep the defaults, which `merge` backfills.
 * - Anything older than v3 had no `migrate` before this one existed, so zustand
 *   dropped it and started from defaults. That is preserved by returning
 *   undefined, which `merge` treats as "nothing persisted".
 *
 * Exported for tests.
 */
export function migratePersistedState(persisted: unknown, version: number): unknown {
  if (version < 3) return undefined;
  if (version < 4) {
    const state = (persisted ?? {}) as { settings?: Partial<Settings> };
    const settings = state.settings;
    if (settings?.onboarded === true) {
      return {
        ...state,
        settings: {
          ...settings,
          gettingStarted: { ...DEFAULT_GETTING_STARTED, dismissedAt: Date.now() },
          hintsSeen: [...ALL_HINT_IDS],
        },
      };
    }
    return state;
  }
  return persisted;
}

/**
 * zustand-persist `merge`: backfill any settings fields missing from older
 * persisted state (runs after {@link migratePersistedState}). Exported for tests.
 */
/** Saved meeting drafts from a persisted payload (anything malformed is
 *  dropped, so a bad entry can't take the store down). */
export function restoredDrafts(persisted: unknown): MeetingDraft[] {
  const raw = (persisted as { drafts?: unknown } | undefined)?.drafts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (d): d is MeetingDraft =>
      !!d &&
      typeof d === "object" &&
      typeof (d as MeetingDraft).id === "string" &&
      Array.isArray((d as MeetingDraft).todos) &&
      ((d as MeetingDraft).meetingAt === null || typeof (d as MeetingDraft).meetingAt === "number"),
  );
}

export function mergePersistedState(persisted: unknown, current: ParleyState): ParleyState {
  const persistedSettings =
    (persisted as { settings?: Partial<Settings> & { voiceTypingPolish?: unknown } } | undefined)
      ?.settings ?? {};
  // The retired on/off polish switch is read once, below, and not carried
  // forward into the live settings.
  const { voiceTypingPolish: legacyPolish, ...p } = persistedSettings;
  // Template shapes changed over time; fall back to defaults if the
  // persisted value is an old shape (e.g. todoTemplates used to be string[]).
  const validTodoTpls = isTemplateList(p.todoTemplates, "items");
  const validEvalTpls = isTemplateList(p.evalTemplates, "evals");
  const { llmProviders, models, reasoningEffort } = migrateLlmSettings(p);

  // Resolve built-in templates into the persisted language so they match
  // the UI on rehydrate.
  const language = (p.language as AppLanguage) ?? DEFAULT_SETTINGS.language;
  const t = tFor(language);

  // Relabel built-in active evaluations to the persisted language too,
  // keeping any custom (non-built-in id) evaluations as saved.
  const persistedEvals: EvalDef[] = (p.evaluations as Settings["evaluations"]) ?? defaultEvalDefs(t);
  const relabeledEvals = relabelBuiltinEvals(persistedEvals, language);

  // Layout presets were renamed in the live-screen redesign; map the old
  // values so persisted states land on the closest new posture.
  const rawLayout = p.layout as string | undefined;
  const layout: Settings["layout"] =
    rawLayout === "transcript" ? "transcript" : DEFAULT_SETTINGS.layout;

  return {
    ...current,
    drafts: restoredDrafts(persisted),
    settings: {
      ...DEFAULT_SETTINGS,
      ...p,
      layout,
      // Windows never had a way to choose this, so a mac-only trigger in
      // persisted state is stale default, not intent — see
      // migrateVoiceTypingShortcut.
      voiceTypingShortcut: migrateVoiceTypingShortcut(p.voiceTypingShortcut),
      // The on/off switch became a style: off → off, on → tidy.
      voiceTypingPolishStyle: migrateVoiceTypingPolishStyle({
        voiceTypingPolishStyle: p.voiceTypingPolishStyle,
        voiceTypingPolish: legacyPolish,
      }),
      llmProviders,
      // Per-provider models, legacy {ask,eval} roles already remapped;
      // providers missing from persisted state keep their defaults.
      models,
      // Backfill delivery-coaching toggles for states saved before they existed.
      delivery: { ...DEFAULT_SETTINGS.delivery, ...p.delivery },
      reasoningEffort,
      // Fold latest built-in templates over persisted ones, keeping customs.
      todoTemplates: reconcileTemplates(
        buildPresetTodoTemplates(t),
        validTodoTpls ? p.todoTemplates! : []
      ),
      evalTemplates: reconcileTemplates(
        buildPresetEvalTemplates(t),
        validEvalTpls ? p.evalTemplates! : []
      ),
      // Backfill checklist flags / seen hints for states saved before them.
      gettingStarted: backfillGettingStarted(p.gettingStarted),
      hintsSeen: Array.isArray(p.hintsSeen)
        ? p.hintsSeen.filter((h): h is HintId => typeof h === "string")
        : [],
    },
    evaluations: evalsFromDefs(relabeledEvals),
    // Restore the persisted cloud sign-in (re-validated on startup).
    cloudAuth: (persisted as { cloudAuth?: CloudAuth } | undefined)?.cloudAuth ?? null,
  };
}

/** The zustand `persist` options, unchanged since v4: one localStorage key
 *  holding settings + the cloud sign-in — transcript/eval state is per-session. */
export const PERSIST_OPTIONS = {
  name: "parley-settings",
  version: PERSIST_VERSION,
  migrate: migratePersistedState,
  // Persist settings + the cloud sign-in — transcript/eval state is per-session.
  // Saved meeting drafts ride along: 即將開始 and their reminders survive a restart.
  partialize: (state: ParleyState) => ({
    settings: state.settings,
    cloudAuth: state.cloudAuth,
    drafts: state.drafts,
  }),
  // Backfill any settings fields missing from older persisted state.
  merge: mergePersistedState,
};
