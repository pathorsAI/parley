// Core domain types for Parley.

/**
 * Who produced a given chunk of speech. "mix" is the combined mic+system stream
 * used with diarizing providers, where speakers are told apart by diarization
 * rather than by capture source.
 */
export type Source = "me" | "them" | "mix";

/** Speech-to-text providers (mirrors the Rust `SttProvider` ids). */
export type SttProviderId = "soniox" | "deepgram" | "assemblyai" | "openai" | "gemini";

/**
 * A single transcript segment from a Soniox realtime session.
 * Non-final segments are mutated in place as new tokens arrive; once `isFinal`
 * is true the text is locked and the segment is considered settled.
 */
export interface TranscriptSegment {
  id: string;
  source: Source;
  /** Diarized speaker number within the source (0 = unknown / single speaker). */
  speaker: number;
  text: string;
  isFinal: boolean;
  /** Milliseconds since the meeting started. */
  startMs: number;
  endMs: number;
}

/** Severity attached to an evaluation result. */
export type Severity = "info" | "warn" | "critical";

/** Lifecycle status of an evaluation. */
export type EvalStatus = "idle" | "running" | "ok" | "flag" | "error";

/** A single piece of evidence backing an evaluation finding. */
export interface EvalEvidence {
  quote: string;
  source: Source;
  reason: string;
}

/** Structured result produced by running an evaluation over the transcript. */
export interface EvalResult {
  /** True when the evaluation considers the situation worth surfacing. */
  flagged: boolean;
  severity: Severity;
  summary: string;
  evidence: EvalEvidence[];
}

/**
 * The editable definition of an evaluation — what it is and what to look for.
 * Lives in Settings so it persists and syncs across windows.
 */
export interface EvalDef {
  id: string;
  name: string;
  description: string;
  /** The instruction handed to the LLM, describing what to look for. */
  prompt: string;
}

/** A named, reusable set of evaluation definitions you can apply to a meeting. */
export interface EvalTemplate {
  id: string;
  name: string;
  /** Built-in templates ship with the app and can't be deleted/renamed. */
  builtin?: boolean;
  evals: EvalDef[];
}

/** A definition plus its live runtime state, held in the store during a meeting. */
export interface Evaluation extends EvalDef {
  status: EvalStatus;
  lastRunAt?: number;
  result?: EvalResult;
}

/**
 * Strategic-angle taxonomy for reply options. Used by the per-finding solution
 * engine ({@link SolutionReply}) to tag each suggested reply and drive its accent
 * colour + i18n label (`wargame.kind.*`).
 */
export type WargameStrategyKind = "rebut" | "reframe" | "trade" | "concede_redirect";

/**
 * A per-finding "how should I reply" solution. Given ONE notable moment, the
 * engine reasons over the WHOLE negotiation (global, not just the local
 * exchange) and returns a few ready-to-use reply options — minimal prose, no
 * diagnosis of what went wrong.
 */

/** One concrete way ME could reply at this moment, with a one-line consideration. */
export interface SolutionReply {
  /** Reuses the war-game angle taxonomy so accent colors + i18n labels carry over. */
  kind: WargameStrategyKind;
  /** The actual line ME should say — verbatim, ready to use at the table. */
  reply: string;
  /** ONE short line: the key trade-off / what this reply does for the overall negotiation. */
  consideration: string;
}

/** The full solution for one finding: a few distinct reply options. */
export interface FindingSolution {
  findingId: string;
  /** 2-3 distinct ready-to-use reply options, spanning angles where sensible. */
  replies: SolutionReply[];
}

/** Lazy per-finding solution cache entry, keyed by TimelineEvent.id in the store. */
export interface FindingSolutionEntry {
  status: "idle" | "running" | "done" | "error";
  solution: FindingSolution | null;
  error: string | null;
}

/**
 * One time-anchored finding from the whole-recording retro analysis, rendered as
 * a marker on the replay timeline. Two lanes (`side`): "them" = a point/argument/
 * pressure the other party raised; "me" = a problem/mistake/missed move by ME.
 */
export interface TimelineEvent {
  id: string;
  /** Moment on the recording timeline (ms). */
  atMs: number;
  /** My problem vs their move → which lane the marker sits in. */
  side: "me" | "them";
  severity: "info" | "warn" | "critical";
  /** From a configured evaluation, or an AI-caught "extra" moment. */
  source: "eval" | "extra";
  /** The evaluations this moment matches — a single moment can match several;
   *  absent/empty for an "extra" moment. */
  evalIds?: string[];
  /** Short label (eval name, or the AI's label). */
  title: string;
  /** One or two sentences explaining the moment. */
  detail: string;
  /** Supporting verbatim quotes — several when they belong together (e.g. BOTH
   *  sides of a contradiction, or a promise and its walk-back). */
  quotes?: string[];
}

/** A meeting to-do / agenda item to make sure gets covered. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * A post-meeting action item generated from the replay analysis — a concrete
 * next step / follow-up, optionally linked back to the finding that motivated it.
 * Deliberately distinct from TodoItem (a pre-meeting agenda checkbox): action
 * items are generated, carry a rationale, and link to a moment on the recording.
 */
export interface ActionItem {
  id: string;
  /** The concrete next step / follow-up. */
  text: string;
  /** Why it matters — e.g. "because at 12:30 you conceded the price floor". */
  rationale: string;
  done: boolean;
  /** The TimelineEvent it derives from, or null for a general item. */
  linkedEventId: string | null;
  /** Seek target on the recording (from the linked event/cited time), or null. */
  atMs: number | null;
  /** Carried from the linked finding, for the chip color. */
  severity?: Severity;
}

/** A named, reusable checklist you can apply to a meeting. */
export interface TodoTemplate {
  id: string;
  name: string;
  builtin?: boolean;
  items: string[];
}

/** High-level meeting lifecycle state. */
export type MeetingStatus = "idle" | "recording" | "stopped";

/** Which LLM provider to route inference through. */
export type LlmProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "groq"
  | "qwen"
  | "kimi"
  | "ollama"
  | "openrouter";

/** Reasoning depth for reasoning-capable models (e.g. Groq gpt-oss). */
export type ReasoningEffort = "low" | "medium" | "high";

/** Separate reasoning depths for the fast Q&A model and deeper eval model. */
export interface ModelReasoningEfforts {
  ask: ReasoningEffort;
  eval: ReasoningEffort;
}

/** UI language. */
export type AppLanguage = "zh-TW" | "en";

/** UI color theme preference. */
export type AppTheme = "light" | "dark" | "system";

/** Main window panel layout preference. */
export type AppLayout = "full" | "assistant" | "transcript";

/** Model ids for one provider: a fast model for Q&A, a stronger one for evals. */
export interface ProviderModels {
  ask: string;
  eval: string;
}

export interface Settings {
  language: AppLanguage;
  theme: AppTheme;
  layout: AppLayout;
  /** False until the first-run onboarding wizard is completed or skipped. */
  onboarded: boolean;
  /** Your name — helps the AI recognize when you're speaking or addressed. */
  userName: string;
  /** Your role / title — tailors the assistance to your seat at the table. */
  userRole: string;
  /** Your company / org — optional extra context. */
  userCompany: string;
  /** Free-text background on you / your side — product, goals, the deal, etc.
   *  Injected into every analysis prompt so the model knows which side is "us". */
  userBackground: string;
  provider: LlmProvider;
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  qwenApiKey: string;
  kimiApiKey: string;
  /** Optional — only needed for a remote/secured Ollama; local needs none. */
  ollamaApiKey: string;
  openrouterApiKey: string;
  /** Reasoning depth per model role for reasoning-capable models. */
  reasoningEffort: ModelReasoningEfforts;
  /** Per-provider model ids (ids differ between Anthropic and OpenRouter). */
  models: Record<LlmProvider, ProviderModels>;
  /** Active speech-to-text provider. */
  transcriptionProvider: SttProviderId;
  sonioxApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  /** Microphone input device name; empty = system default. */
  inputDevice: string;
  /** The active evaluation set used in meetings (the runtime copy lives in the store). */
  evaluations: EvalDef[];
  /** Library of evaluation templates (built-in + custom) you can apply. */
  evalTemplates: EvalTemplate[];
  /** Library of TODO/agenda templates (built-in + custom) you can apply. */
  todoTemplates: TodoTemplate[];
}
