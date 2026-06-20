import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Evaluation,
  EvalResult,
  EvalStatus,
  MeetingStatus,
  Settings,
  TodoItem,
  TranscriptSegment,
} from "./types";
import type { ReplaySession } from "./replay/types";
import { PRESET_EVAL_DEFS, PRESET_EVAL_TEMPLATES, evalsFromDefs } from "./evaluations/presets";
import { reconcileTemplates } from "./templates";
import { PRESET_TODO_TEMPLATES } from "./todoTemplates";
import { DEFAULT_MODELS } from "./ai/providers";

/**
 * Optional dev convenience: API keys from a gitignored `.env` (VITE_* vars).
 * Empty/undefined in any published build (no .env), so nothing is baked in.
 * Only defined keys are included, so they overlay without clobbering UI values.
 */
const ENV_KEYS: Partial<Settings> = Object.fromEntries(
  (
    [
      ["sonioxApiKey", import.meta.env.VITE_SONIOX_API_KEY],
      ["anthropicApiKey", import.meta.env.VITE_ANTHROPIC_API_KEY],
      ["openaiApiKey", import.meta.env.VITE_OPENAI_API_KEY],
      ["geminiApiKey", import.meta.env.VITE_GEMINI_API_KEY],
      ["openrouterApiKey", import.meta.env.VITE_OPENROUTER_API_KEY],
      ["groqApiKey", import.meta.env.VITE_GROQ_API_KEY],
      ["qwenApiKey", import.meta.env.VITE_QWEN_API_KEY],
      ["kimiApiKey", import.meta.env.VITE_KIMI_API_KEY],
      ["ollamaApiKey", import.meta.env.VITE_OLLAMA_API_KEY],
    ] as const
  ).filter(([, v]) => !!v)
) as Partial<Settings>;

const DEFAULT_SETTINGS: Settings = {
  language: "zh-TW",
  theme: "system",
  layout: "full",
  onboarded: false,
  userName: "",
  userRole: "",
  userCompany: "",
  provider: "anthropic",
  anthropicApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  openrouterApiKey: "",
  groqApiKey: "",
  qwenApiKey: "",
  kimiApiKey: "",
  ollamaApiKey: "",
  reasoningEffort: { ask: "low", eval: "medium" },
  models: DEFAULT_MODELS,
  transcriptionProvider: "soniox",
  sonioxApiKey: "",
  deepgramApiKey: "",
  assemblyaiApiKey: "",
  inputDevice: "",
  evaluations: PRESET_EVAL_DEFS,
  evalTemplates: PRESET_EVAL_TEMPLATES,
  todoTemplates: PRESET_TODO_TEMPLATES,
  ...ENV_KEYS,
};

/** Whether the app is capturing a live meeting or analyzing an uploaded one. */
export type AppMode = "live" | "replay";

interface ParleyState {
  /**
   * "live" = capturing mic/system audio now; "replay" = analyzing an uploaded
   * recording. In replay mode the uploaded transcript is loaded into `segments`,
   * so every existing panel (transcript, evals, ask, report) works unchanged —
   * the only twist is `visibleSegments` masks them to `replayPlayheadMs`.
   */
  appMode: AppMode;
  /** The uploaded recording under analysis (null in live mode). */
  replay: ReplaySession | null;
  /** Scrub position (ms) in replay mode; transcript is masked to at/under this. */
  replayPlayheadMs: number;
  /** Load an uploaded recording and switch into replay mode. */
  enterReplay: (session: ReplaySession) => void;
  /** Leave replay mode and return to a clean live/idle state. */
  exitReplay: () => void;
  /** Move the replay playhead (drives both audio position and transcript mask). */
  setReplayPlayhead: (ms: number) => void;

  meetingStatus: MeetingStatus;
  meetingStartedAt: number | null;
  segments: TranscriptSegment[];
  evaluations: Evaluation[];
  settings: Settings;
  /** Live speaker-key → custom name map (e.g. "them-1" → "重高"). Per meeting. */
  speakerNames: Record<string, string>;
  /** Meeting to-do / agenda checklist. */
  todos: TodoItem[];
  /** Per-meeting context/description (who's here, roles) — NOT a global setting. */
  meetingContext: string;
  setMeetingContext: (text: string) => void;

  /**
   * A transcript time (ms) the UI should jump to and briefly highlight — set by
   * clicking a timestamp in the debrief. Generic on purpose: a future recording
   * player could consume the same signal. Consumers clear it after handling.
   */
  highlightMs: number | null;
  setHighlightMs: (ms: number | null) => void;

  // todos
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  removeTodo: (id: string) => void;
  /** Mark the given todo ids as done (used by the AI auto-checker). */
  markTodosDone: (ids: string[]) => void;
  /** Replace the checklist with a template's items (all unchecked). */
  applyTodoTemplate: (items: string[]) => void;

  // meeting lifecycle
  startMeeting: () => void;
  stopMeeting: () => void;

  /** Assign/clear a custom name for a speaker key. */
  setSpeakerName: (key: string, name: string) => void;

  // transcript
  /**
   * Upsert a segment by id. Realtime sources emit the same id repeatedly with
   * growing text (partial → final); we replace in place rather than appending.
   */
  upsertSegment: (segment: TranscriptSegment) => void;
  clearTranscript: () => void;

  // evaluations
  setEvalStatus: (id: string, status: EvalStatus) => void;
  setEvalResult: (id: string, result: EvalResult) => void;
  setAllEvalStatus: (status: EvalStatus) => void;
  /** Whether to auto-rerun the whole evaluation set on an interval while recording. */
  autoEval: boolean;
  autoEvalSec: number;
  setAutoEval: (on: boolean) => void;
  setAutoEvalSec: (sec: number) => void;

  // settings
  updateSettings: (patch: Partial<Settings>) => void;
  /** Replace settings wholesale — used to sync from the settings window. */
  applySettings: (settings: Settings) => void;
}

export const useStore = create<ParleyState>()(
  persist(
    (set) => ({
      appMode: "live",
      replay: null,
      replayPlayheadMs: 0,
      meetingStatus: "idle",
      meetingStartedAt: null,
      segments: [],
      evaluations: evalsFromDefs(DEFAULT_SETTINGS.evaluations),
      settings: DEFAULT_SETTINGS,
      speakerNames: {},
      todos: [],
      meetingContext: "",
      autoEval: false,
      autoEvalSec: 30,
      highlightMs: null,

  setMeetingContext: (text) => set({ meetingContext: text }),
  setHighlightMs: (ms) => set({ highlightMs: ms }),

  enterReplay: (session) =>
    set({
      appMode: "replay",
      replay: session,
      // Default the playhead to the end so the full transcript shows; the user
      // drags back to a moment to mask the future before re-evaluating.
      replayPlayheadMs: session.durationMs,
      segments: session.segments,
      speakerNames: session.speakerNames,
      meetingStatus: "stopped",
      highlightMs: null,
    }),

  exitReplay: () =>
    set({
      appMode: "live",
      replay: null,
      replayPlayheadMs: 0,
      segments: [],
      speakerNames: {},
      meetingStatus: "idle",
      highlightMs: null,
    }),

  setReplayPlayhead: (ms) => set({ replayPlayheadMs: Math.max(0, ms) }),

  addTodo: (text) =>
    set((state) => {
      const t = text.trim();
      if (!t) return {};
      return { todos: [...state.todos, { id: crypto.randomUUID(), text: t, done: false }] };
    }),

  toggleTodo: (id) =>
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    })),

  removeTodo: (id) => set((state) => ({ todos: state.todos.filter((t) => t.id !== id) })),

  markTodosDone: (ids) =>
    set((state) => {
      const set_ = new Set(ids);
      return { todos: state.todos.map((t) => (set_.has(t.id) ? { ...t, done: true } : t)) };
    }),

  applyTodoTemplate: (items) =>
    set({
      todos: items
        .filter((t) => t.trim())
        .map((t) => ({ id: crypto.randomUUID(), text: t.trim(), done: false })),
    }),

  startMeeting: () =>
    set({
      meetingStatus: "recording",
      meetingStartedAt: Date.now(),
      segments: [],
      speakerNames: {},
    }),

  setSpeakerName: (key, name) =>
    set((state) => {
      const next = { ...state.speakerNames };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      return { speakerNames: next };
    }),

  stopMeeting: () => set({ meetingStatus: "stopped" }),

  upsertSegment: (segment) =>
    set((state) => {
      const idx = state.segments.findIndex((s) => s.id === segment.id);
      if (idx === -1) {
        return { segments: [...state.segments, segment] };
      }
      const next = state.segments.slice();
      next[idx] = segment;
      return { segments: next };
    }),

  clearTranscript: () => set({ segments: [] }),

  setEvalStatus: (id, status) =>
    set((state) => ({
      evaluations: state.evaluations.map((e) =>
        e.id === id ? { ...e, status } : e
      ),
    })),

  setEvalResult: (id, result) =>
    set((state) => ({
      evaluations: state.evaluations.map((e) =>
        e.id === id
          ? {
              ...e,
              result,
              status: result.flagged ? "flag" : "ok",
              lastRunAt: Date.now(),
            }
          : e
      ),
    })),

  setAllEvalStatus: (status) =>
    set((state) => ({ evaluations: state.evaluations.map((e) => ({ ...e, status })) })),

  setAutoEval: (on) => set({ autoEval: on }),
  setAutoEvalSec: (sec) => set({ autoEvalSec: Math.max(5, sec || 30) }),

  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch };
      return {
        settings,
        evaluations: evalsFromDefs(settings.evaluations, state.evaluations),
      };
    }),

  applySettings: (settings) =>
    set((state) => ({
      settings,
      evaluations: evalsFromDefs(settings.evaluations, state.evaluations),
    })),
    }),
    {
      name: "parley-settings",
      version: 3,
      // Persist only settings — transcript and eval state are per-session.
      partialize: (state) => ({ settings: state.settings }),
      // Backfill any settings fields missing from older persisted state.
      merge: (persisted, current) => {
        const p = (persisted as { settings?: Partial<Settings> } | undefined)?.settings ?? {};
        // Template shapes changed over time; fall back to defaults if the
        // persisted value is an old shape (e.g. todoTemplates used to be string[]).
        const validTodoTpls =
          Array.isArray(p.todoTemplates) &&
          p.todoTemplates.every((t) => t && typeof t === "object" && Array.isArray((t as { items?: unknown }).items));
        const validEvalTpls =
          Array.isArray(p.evalTemplates) &&
          p.evalTemplates.every((t) => t && typeof t === "object" && Array.isArray((t as { evals?: unknown }).evals));
        const persistedReasoning = p.reasoningEffort;
        const reasoningEffort =
          typeof persistedReasoning === "string"
            ? { ask: persistedReasoning, eval: persistedReasoning }
            : { ...DEFAULT_SETTINGS.reasoningEffort, ...(persistedReasoning ?? {}) };

        return {
          ...current,
          settings: {
            ...DEFAULT_SETTINGS,
            ...p,
            // Deep-merge models so a new provider (e.g. groq) isn't dropped by
            // older persisted state that only had anthropic/openrouter.
            models: { ...DEFAULT_SETTINGS.models, ...(p.models ?? {}) },
            reasoningEffort,
            // Fold latest built-in templates over persisted ones, keeping customs.
            todoTemplates: reconcileTemplates(
              PRESET_TODO_TEMPLATES,
              validTodoTpls ? p.todoTemplates! : []
            ),
            evalTemplates: reconcileTemplates(
              PRESET_EVAL_TEMPLATES,
              validEvalTpls ? p.evalTemplates! : []
            ),
            // Dev .env keys win over persisted-empty values (no-op in prod).
            ...ENV_KEYS,
          },
          evaluations: evalsFromDefs(
            (p.evaluations as Settings["evaluations"]) ?? DEFAULT_SETTINGS.evaluations
          ),
        };
      },
    }
  )
);

/**
 * The transcript the AI is allowed to see right now. Identical to `segments` in
 * live mode; in replay mode it's masked to segments at/under the playhead, so an
 * evaluation re-run simulates "what was known at this moment" — the core of the
 * scrub-and-evaluate retro flow. Pass the store state (or the relevant slice).
 */
export function visibleSegments(
  state: Pick<ParleyState, "appMode" | "replayPlayheadMs" | "segments">
): TranscriptSegment[] {
  if (state.appMode === "replay") {
    return state.segments.filter((s) => s.startMs <= state.replayPlayheadMs);
  }
  return state.segments;
}

/**
 * A stable key per distinct speaker. Includes the diarized speaker number on
 * BOTH sources, so multiple people sharing the mic (in-person) are separated,
 * not just remote speakers on the system-audio side.
 */
export function speakerKey(s: Pick<TranscriptSegment, "source" | "speaker">): string {
  return `${s.source}-${s.speaker || 0}`;
}

/** Default label (no custom name). The primary mic voice is "You". */
export function defaultSpeakerLabel(s: Pick<TranscriptSegment, "source" | "speaker">): string {
  // Mixed stream: no deterministic me/them — label purely by diarized speaker.
  if (s.source === "mix") return `Speaker ${s.speaker || 1}`;
  if (s.source === "me") return (s.speaker || 1) <= 1 ? "You" : `Speaker ${s.speaker}`;
  return s.speaker > 0 ? `Remote ${s.speaker}` : "Them";
}

/** Display label, preferring a user-assigned name from `names` when present. */
export function speakerLabel(
  s: Pick<TranscriptSegment, "source" | "speaker">,
  names?: Record<string, string>
): string {
  return names?.[speakerKey(s)] || defaultSpeakerLabel(s);
}

/** Final-only transcript text, labelled by speaker (with custom names) — LLM context. */
export function transcriptAsText(
  segments: TranscriptSegment[],
  names?: Record<string, string>
): string {
  return [...segments]
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => `[${speakerLabel(s, names)}] ${s.text.trim()}`)
    .join("\n");
}

/** Format a meeting-relative millisecond offset as m:ss. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Like transcriptAsText but each line is prefixed with its [m:ss] start time,
 *  so the model can cite moments the UI can jump back to. */
export function transcriptWithTimestamps(
  segments: TranscriptSegment[],
  names?: Record<string, string>
): string {
  return [...segments]
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => `[${formatClock(s.startMs)}] [${speakerLabel(s, names)}] ${s.text.trim()}`)
    .join("\n");
}
