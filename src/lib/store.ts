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
import { PRESET_EVAL_DEFS, evalsFromDefs } from "./evaluations/presets";

const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  anthropicApiKey: "",
  openrouterApiKey: "",
  models: {
    anthropic: { ask: "claude-sonnet-4-6", eval: "claude-opus-4-8" },
    // OpenRouter slugs — editable in Settings; adjust if a slug 404s.
    openrouter: { ask: "anthropic/claude-sonnet-4.5", eval: "anthropic/claude-opus-4.1" },
  },
  sonioxApiKey: "",
  inputDevice: "",
  meetingContext: "",
  evaluations: PRESET_EVAL_DEFS,
  todoTemplates: [],
};

interface ParleyState {
  meetingStatus: MeetingStatus;
  meetingStartedAt: number | null;
  segments: TranscriptSegment[];
  evaluations: Evaluation[];
  settings: Settings;
  /** Live speaker-key → custom name map (e.g. "them-1" → "重高"). Per meeting. */
  speakerNames: Record<string, string>;
  /** Meeting to-do / agenda checklist. */
  todos: TodoItem[];

  // todos
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  removeTodo: (id: string) => void;
  /** Mark the given todo ids as done (used by the AI auto-checker). */
  markTodosDone: (ids: string[]) => void;

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

  // settings
  updateSettings: (patch: Partial<Settings>) => void;
  /** Replace settings wholesale — used to sync from the settings window. */
  applySettings: (settings: Settings) => void;
}

export const useStore = create<ParleyState>()(
  persist(
    (set) => ({
      meetingStatus: "idle",
      meetingStartedAt: null,
      segments: [],
      evaluations: evalsFromDefs(DEFAULT_SETTINGS.evaluations),
      settings: DEFAULT_SETTINGS,
      speakerNames: {},
      todos: [],

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

  startMeeting: () =>
    set((state) => ({
      meetingStatus: "recording",
      meetingStartedAt: Date.now(),
      segments: [],
      speakerNames: {},
      // Seed the checklist from templates (keep any todos the user pre-added).
      todos: [
        ...state.settings.todoTemplates
          .filter((t) => t.trim())
          .map((t) => ({ id: crypto.randomUUID(), text: t.trim(), done: false })),
        ...state.todos,
      ],
    })),

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
      version: 2,
      // Persist only settings — transcript and eval state are per-session.
      partialize: (state) => ({ settings: state.settings }),
      // Backfill any settings fields missing from older persisted state.
      merge: (persisted, current) => {
        const p = (persisted as { settings?: Partial<Settings> } | undefined)?.settings ?? {};
        return {
          ...current,
          settings: { ...DEFAULT_SETTINGS, ...p },
          evaluations: evalsFromDefs(
            (p.evaluations as Settings["evaluations"]) ?? DEFAULT_SETTINGS.evaluations
          ),
        };
      },
    }
  )
);

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
