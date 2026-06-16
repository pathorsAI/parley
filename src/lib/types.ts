// Core domain types for Parley.

/** Who produced a given chunk of speech. */
export type Source = "me" | "them";

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
  mode: "auto" | "manual";
  /** Rerun interval for `auto` evaluations, in seconds. */
  autoEverySec?: number;
}

/** A definition plus its live runtime state, held in the store during a meeting. */
export interface Evaluation extends EvalDef {
  status: EvalStatus;
  lastRunAt?: number;
  result?: EvalResult;
}

/** A meeting to-do / agenda item to make sure gets covered. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/** High-level meeting lifecycle state. */
export type MeetingStatus = "idle" | "recording" | "stopped";

/** Which LLM provider to route inference through. */
export type LlmProvider = "anthropic" | "openrouter";

/** Model ids for one provider: a fast model for Q&A, a stronger one for evals. */
export interface ProviderModels {
  ask: string;
  eval: string;
}

export interface Settings {
  provider: LlmProvider;
  anthropicApiKey: string;
  openrouterApiKey: string;
  /** Per-provider model ids (ids differ between Anthropic and OpenRouter). */
  models: Record<LlmProvider, ProviderModels>;
  sonioxApiKey: string;
  /** Microphone input device name; empty = system default. */
  inputDevice: string;
  /** Context for evaluations: what kind of meeting this is (interview/negotiation/…). */
  meetingContext: string;
  /** Editable evaluation definitions (the runtime copy lives in the store). */
  evaluations: EvalDef[];
  /** TODO/agenda templates seeded into each meeting's checklist. */
  todoTemplates: string[];
}
