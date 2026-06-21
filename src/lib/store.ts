import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ActionItem,
  AppLanguage,
  Evaluation,
  FindingSolutionEntry,
  MeetingStatus,
  Settings,
  TimelineEvent,
  TodoItem,
  TranscriptSegment,
} from "./types";
import type { ReplaySession } from "./replay/types";
import {
  buildBuiltinEvalLabels,
  buildPresetEvalDefs,
  buildPresetEvalTemplates,
  evalsFromDefs,
} from "./evaluations/presets";
import { reconcileTemplates } from "./templates";
import { buildPresetTodoTemplates } from "./todoTemplates";
import { translate, type TranslationKey } from "../i18n/messages";
import { DEFAULT_MODELS } from "./ai/providers";
import { log } from "./log";

/** A translate function bound to a language, for resolving built-in templates. */
const tFor = (language: AppLanguage) => (key: TranslationKey) => translate(language, key);

/**
 * Re-resolve all built-in template content (eval templates, TODO templates, and
 * the labels of any active built-in evaluations) into `settings.language`,
 * keeping the user's own custom templates. Called whenever the language changes
 * so built-in content follows the UI language. Custom templates and custom
 * evaluations (ids not in the built-in set) are left untouched.
 */
function relocalizeBuiltins(settings: Settings): Settings {
  const t = tFor(settings.language);
  const labels = buildBuiltinEvalLabels(t);
  return {
    ...settings,
    evalTemplates: reconcileTemplates(buildPresetEvalTemplates(t), settings.evalTemplates),
    todoTemplates: reconcileTemplates(buildPresetTodoTemplates(t), settings.todoTemplates),
    evaluations: settings.evaluations.map((e) => {
      const label = labels.get(e.id);
      return label ? { ...e, name: label.name, description: label.description } : e;
    }),
  };
}

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

// Built-in templates are seeded in the default language; the persist `merge`
// (rehydrate) and `relocalizeBuiltins` (on language change) re-resolve them to
// the active language afterward.
const tDefault = tFor("zh-TW");

const DEFAULT_SETTINGS: Settings = {
  language: "zh-TW",
  theme: "system",
  layout: "full",
  onboarded: false,
  userName: "",
  userRole: "",
  userCompany: "",
  userBackground: "",
  // Default to Groq's gpt-oss (fast + cheap); users can switch in Settings.
  provider: "groq",
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
  evaluations: buildPresetEvalDefs(tDefault),
  evalTemplates: buildPresetEvalTemplates(tDefault),
  todoTemplates: buildPresetTodoTemplates(tDefault),
  ...ENV_KEYS,
};

/** Whether the app is capturing a live meeting or analyzing an uploaded one. */
export type AppMode = "live" | "replay";

/**
 * Replay keep-window. Segments that fall entirely OUTSIDE [startMs, endMs] are
 * trimmed: greyed in the transcript and excluded from every analysis (evals,
 * Ask, timeline, war-gaming, voice diarization). `null` = keep the whole thing.
 * Non-destructive — clearing it restores everything.
 */
export interface ReplayTrim {
  startMs: number;
  endMs: number;
}

interface ParleyState {
  /**
   * "live" = capturing mic/system audio now; "replay" = analyzing an uploaded
   * recording. In replay mode the uploaded transcript is loaded into `segments`,
   * so every panel (transcript, findings, ask, report) works unchanged; the
   * playhead is for navigation/viewing only (no masking).
   */
  appMode: AppMode;
  /** The uploaded recording under analysis (null in live mode). */
  replay: ReplaySession | null;
  /** Scrub position (ms) in replay mode — drives audio + transcript highlight. */
  replayPlayheadMs: number;
  /** Load an uploaded recording and switch into replay mode. */
  enterReplay: (session: ReplaySession) => void;
  /** Leave replay mode and return to a clean live/idle state. */
  exitReplay: () => void;
  /** Move the replay playhead (drives both audio position and the transcript). */
  setReplayPlayhead: (ms: number) => void;
  /**
   * Bumped on every EXPLICIT seek (scrubber, timeline finding, transcript row,
   * action item) — but NOT on passive playback ticks. The transcript watches it
   * to scroll the active line into view on a jump even while paused, so audio ⇄
   * transcript ⇄ timeline stay visually in sync in both directions.
   */
  replaySeekNonce: number;
  bumpReplaySeek: () => void;

  /** Keep-window: segments outside it are excluded from the view + all analysis.
   *  null = no trim. See {@link ReplayTrim} and {@link isTrimmed}. */
  replayTrim: ReplayTrim | null;
  setReplayTrim: (trim: ReplayTrim | null) => void;

  // ── Upload ingest wizard (count → transcribe → trim → diarize → review → analyze) ──
  /** Whether the guided upload pipeline dialog is open. */
  ingestWizardOpen: boolean;
  ingestWizardStep:
    | "count"
    | "transcribing"
    | "trim"
    | "diarizing"
    | "review"
    | "template"
    | "analyzing"
    | "error";
  ingestWizardError: string | null;
  /** Absolute path of the picked recording, set when the wizard opens. */
  ingestAudioPath: string | null;
  openIngestWizard: (audioPath: string) => void;
  setIngestWizardStep: (step: ParleyState["ingestWizardStep"], error?: string | null) => void;
  closeIngestWizard: () => void;
  /**
   * Analysis runs only after the wizard's review-confirm releases this gate.
   * Default "open" so LIVE and any direct re-analysis are never gated; the wizard
   * arms it to "deferred" on open and releases it at Confirm.
   */
  analysisGate: "deferred" | "open";
  releaseAnalysisGate: () => void;

  // ── Unified analysis (shared by LIVE + REPLAY) ──────────────────────────────
  /**
   * Time-anchored findings from an analysis pass (eval-matched or AI "extra").
   * The timeline + findings list render these in both modes. LIVE re-analysis
   * REPLACES the whole list (and clears selection + solutions); REPLAY runs once.
   */
  findings: TimelineEvent[];
  analysisStatus: "idle" | "running" | "done" | "error";
  analysisError: string | null;
  /** Signature of the eval set the current `findings` reflect (set by runAnalysis).
   *  When it differs from the active eval set, the findings are stale → re-analyze. */
  analyzedEvalSig: string;
  setFindings: (events: TimelineEvent[]) => void;
  setAnalysisStatus: (status: ParleyState["analysisStatus"]) => void;
  setAnalysisError: (error: string | null) => void;
  /** Drop findings + action items outside the replay keep-window. Applied when a
   *  trim is committed — clears over-time results without re-running the analysis. */
  dropFindingsOutsideTrim: () => void;

  /** The finding whose "how it should have been done" drilldown is open. */
  selectedFindingId: string | null;
  setSelectedFinding: (id: string | null) => void;

  /** Lazy per-finding solution cache, keyed by TimelineEvent.id. */
  findingSolutions: Record<string, FindingSolutionEntry>;
  setFindingSolution: (id: string, patch: Partial<FindingSolutionEntry>) => void;

  /** Auto-run the analysis on an interval while recording (LIVE; default off). */
  autoAnalyze: boolean;
  autoAnalyzeSec: number;
  setAutoAnalyze: (on: boolean) => void;
  setAutoAnalyzeSec: (sec: number) => void;

  // ── Action items (REPLAY post-meeting follow-ups) ───────────────────────────
  /** Generated from the analysis findings + transcript; ephemeral, replay-only. */
  actionItems: ActionItem[];
  actionItemsStatus: "idle" | "running" | "done" | "error";
  actionItemsError: string | null;
  setActionItems: (items: ActionItem[]) => void;
  setActionItemsStatus: (status: ParleyState["actionItemsStatus"]) => void;
  setActionItemsError: (error: string | null) => void;
  toggleActionItem: (id: string) => void;

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
      replaySeekNonce: 0,
      replayTrim: null,
      ingestWizardOpen: false,
      ingestWizardStep: "count",
      ingestWizardError: null,
      ingestAudioPath: null,
      analysisGate: "open",
      findings: [],
      analysisStatus: "idle",
      analysisError: null,
      analyzedEvalSig: "",
      selectedFindingId: null,
      findingSolutions: {},
      autoAnalyze: false,
      autoAnalyzeSec: 45,
      actionItems: [],
      actionItemsStatus: "idle",
      actionItemsError: null,
      meetingStatus: "idle",
      meetingStartedAt: null,
      segments: [],
      evaluations: evalsFromDefs(DEFAULT_SETTINGS.evaluations),
      settings: DEFAULT_SETTINGS,
      speakerNames: {},
      todos: [],
      meetingContext: "",
      highlightMs: null,

  setMeetingContext: (text) => set({ meetingContext: text }),
  setHighlightMs: (ms) => set({ highlightMs: ms }),

  enterReplay: (session) => {
    log.info("store: enter replay", {
      name: session.name,
      segments: session.segments.length,
      durationMs: session.durationMs,
    });
    set({
      appMode: "replay",
      replay: session,
      // Start at the beginning of the recording (the full transcript always
      // shows now — no masking); the playhead is just for playback/navigation.
      replayPlayheadMs: 0,
      replayTrim: null,
      segments: session.segments,
      speakerNames: session.speakerNames,
      meetingStatus: "stopped",
      highlightMs: null,
      findings: [],
      analysisStatus: "idle",
      analysisError: null,
      analyzedEvalSig: "",
      selectedFindingId: null,
      findingSolutions: {},
      actionItems: [],
      actionItemsStatus: "idle",
      actionItemsError: null,
    });
  },

  exitReplay: () => {
    log.info("store: exit replay");
    set({
      appMode: "live",
      replay: null,
      replayPlayheadMs: 0,
      replayTrim: null,
      ingestWizardOpen: false,
      ingestAudioPath: null,
      analysisGate: "open",
      segments: [],
      speakerNames: {},
      meetingStatus: "idle",
      highlightMs: null,
      findings: [],
      analysisStatus: "idle",
      analysisError: null,
      analyzedEvalSig: "",
      selectedFindingId: null,
      findingSolutions: {},
      actionItems: [],
      actionItemsStatus: "idle",
      actionItemsError: null,
    });
  },

  setReplayPlayhead: (ms) => set({ replayPlayheadMs: Math.max(0, ms) }),
  bumpReplaySeek: () => set((s) => ({ replaySeekNonce: s.replaySeekNonce + 1 })),

  setReplayTrim: (trim) => set({ replayTrim: trim }),

  // Ingest wizard. Opening ARMS the analysis gate ("deferred") so loading the
  // session behind the dialog doesn't auto-analyze; the review-confirm releases it.
  openIngestWizard: (audioPath) =>
    set({
      ingestWizardOpen: true,
      ingestWizardStep: "count",
      ingestWizardError: null,
      ingestAudioPath: audioPath,
      analysisGate: "deferred",
    }),
  setIngestWizardStep: (step, error = null) =>
    set({ ingestWizardStep: step, ingestWizardError: error }),
  closeIngestWizard: () => set({ ingestWizardOpen: false, ingestAudioPath: null }),
  releaseAnalysisGate: () => set({ analysisGate: "open" }),

  // Replace the findings list, keeping the selection + cached solutions of any
  // finding that STILL EXISTS in the new list. During streaming, partials commit
  // a growing list with stable ids, so a finding the user opened mid-stream (and
  // its in-flight "how to reply" solution) survives the next partial. A fresh
  // analysis pass mints new ids, so nothing matches → selection + solutions clear.
  setFindings: (events) =>
    set((s) => {
      const ids = new Set(events.map((e) => e.id));
      const keepSel = !!s.selectedFindingId && ids.has(s.selectedFindingId);
      const findingSolutions = Object.fromEntries(
        Object.entries(s.findingSolutions).filter(([id]) => ids.has(id))
      );
      return {
        findings: events,
        selectedFindingId: keepSel ? s.selectedFindingId : null,
        findingSolutions,
      };
    }),

  dropFindingsOutsideTrim: () =>
    set((s) => {
      const trim = s.replayTrim;
      if (!trim) return {}; // no trim → nothing to clear
      const inWin = (atMs: number) => atMs >= trim.startMs && atMs <= trim.endMs;
      const keepSel = s.findings.some((f) => f.id === s.selectedFindingId && inWin(f.atMs));
      return {
        findings: s.findings.filter((f) => inWin(f.atMs)),
        actionItems: s.actionItems.filter((a) => a.atMs == null || inWin(a.atMs)),
        selectedFindingId: keepSel ? s.selectedFindingId : null,
      };
    }),
  setAnalysisStatus: (status) => set({ analysisStatus: status }),
  setAnalysisError: (error) => set({ analysisError: error }),
  setSelectedFinding: (id) => set({ selectedFindingId: id }),
  setFindingSolution: (id, patch) =>
    set((state) => {
      const prev = state.findingSolutions[id] ?? { status: "idle", solution: null, error: null };
      return { findingSolutions: { ...state.findingSolutions, [id]: { ...prev, ...patch } } };
    }),
  setAutoAnalyze: (on) => set({ autoAnalyze: on }),
  setAutoAnalyzeSec: (sec) => set({ autoAnalyzeSec: Math.max(20, sec || 45) }),

  setActionItems: (items) => set({ actionItems: items }),
  setActionItemsStatus: (status) => set({ actionItemsStatus: status }),
  setActionItemsError: (error) => set({ actionItemsError: error }),
  toggleActionItem: (id) =>
    set((state) => ({
      actionItems: state.actionItems.map((a) => (a.id === id ? { ...a, done: !a.done } : a)),
    })),

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

  startMeeting: () => {
    log.info("store: meeting started");
    set({
      meetingStatus: "recording",
      meetingStartedAt: Date.now(),
      segments: [],
      speakerNames: {},
      findings: [],
      analysisStatus: "idle",
      analysisError: null,
      analyzedEvalSig: "",
      selectedFindingId: null,
      findingSolutions: {},
    });
  },

  setSpeakerName: (key, name) =>
    set((state) => {
      const next = { ...state.speakerNames };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      // Persist names per uploaded recording so re-uploading restores them. Replay
      // only — a live meeting has no stable on-disk recording to key against.
      if (state.replay?.audioPath) {
        void import("./speakers/namesCache").then(({ writeSpeakerNames, speakerCountOf }) =>
          writeSpeakerNames(state.replay!.audioPath, speakerCountOf(state.segments), next)
        );
      }
      return { speakerNames: next };
    }),

  stopMeeting: () => {
    log.info("store: meeting stopped");
    set({ meetingStatus: "stopped" });
  },

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

  updateSettings: (patch) =>
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
    }),

  applySettings: (settings) =>
    set((state) => ({
      // Trust the incoming settings: the broadcasting window already re-resolves
      // built-in templates whenever its language changes, so they arrive in the
      // right language (and any user edits are preserved).
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

        // Resolve built-in templates into the persisted language so they match
        // the UI on rehydrate.
        const language = (p.language as AppLanguage) ?? DEFAULT_SETTINGS.language;
        const t = tFor(language);

        // Relabel built-in active evaluations to the persisted language too,
        // keeping any custom (non-built-in id) evaluations as saved.
        const builtinLabels = buildBuiltinEvalLabels(t);
        const persistedEvals =
          (p.evaluations as Settings["evaluations"]) ?? buildPresetEvalDefs(t);
        const relabeledEvals = persistedEvals.map((e) => {
          const label = builtinLabels.get(e.id);
          return label ? { ...e, name: label.name, description: label.description } : e;
        });

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
              buildPresetTodoTemplates(t),
              validTodoTpls ? p.todoTemplates! : []
            ),
            evalTemplates: reconcileTemplates(
              buildPresetEvalTemplates(t),
              validEvalTpls ? p.evalTemplates! : []
            ),
            // Dev .env keys win over persisted-empty values (no-op in prod).
            ...ENV_KEYS,
          },
          evaluations: evalsFromDefs(relabeledEvals),
        };
      },
    }
  )
);

/**
 * Is this segment outside the replay keep-window (i.e. trimmed away)? A segment
 * is KEPT when it overlaps [startMs, endMs] at all, so a turn straddling a trim
 * boundary stays. `null` trim means nothing is trimmed. Used to grey trimmed
 * lines in the transcript and to exclude them from every replay analysis.
 */
export function isTrimmed(
  s: Pick<TranscriptSegment, "startMs" | "endMs">,
  trim: ReplayTrim | null
): boolean {
  if (!trim) return false;
  return s.endMs < trim.startMs || s.startMs > trim.endMs;
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
