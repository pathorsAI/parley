// Core domain types for Parley.

/**
 * Who produced a given chunk of speech. "mix" is the combined mic+system stream
 * used with diarizing providers, where speakers are told apart by diarization
 * rather than by capture source.
 */
export type Source = "me" | "them" | "mix";

/** Speech-to-text providers (mirrors the Rust `SttProvider` ids). */
export type SttProviderId = "soniox" | "deepgram" | "assemblyai" | "openai" | "gemini" | "parley";

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
  /** REPLAY/post-eval: true when ME LATER addressed / defused / answered this
   *  moment elsewhere in the conversation. Rendered GREEN ("resolved") instead of
   *  the severity colour, and its {@link resolution} is fed to the reply coach so
   *  suggestions build on what ME already said rather than ignoring it. */
  resolved?: boolean;
  /** One short line on HOW ME handled it — present only when {@link resolved}. */
  resolution?: string;
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
  | "openrouter"
  | "parley";

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
  /** Current onboarding wizard step, persisted so granting a permission (which
   *  often needs an app restart) resumes where you left off instead of step 1. */
  onboardingStep: number;
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
  /** Unused — the hosted "parley" provider authenticates with the Better Auth
   *  session token, not an API key. Present so it satisfies the closed
   *  apiKeyField union (every provider has a key field). */
  parleyApiKey: string;
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
  /** Voice typing: after releasing the push-to-talk key, also paste the text
   *  into the frontmost app (simulated ⌘V). Off by default; needs Accessibility. */
  voiceTypingAutoPaste: boolean;
  /** The active evaluation set used in meetings (the runtime copy lives in the store). */
  evaluations: EvalDef[];
  /** Library of evaluation templates (built-in + custom) you can apply. */
  evalTemplates: EvalTemplate[];
  /** Library of TODO/agenda templates (built-in + custom) you can apply. */
  todoTemplates: TodoTemplate[];
  /** Per-metric opt-in for live delivery coaching (see DeliveryToggles). */
  delivery: DeliveryToggles;
  /** Whether to sync personal recordings + folders to Parley Cloud while signed in.
   *  Off → this device keeps everything local (no automatic push/pull); explicit
   *  org sharing still works. Default on (preserves the prior signed-in behavior). */
  syncEnabled: boolean;
  /** Where a finished meeting is saved by default. */
  defaultSaveLocation: DefaultSaveLocation;
}

/**
 * The default destination for auto-saved meetings. A personal folder (or the
 * personal root), or an org folder — in which case the meeting is saved locally at
 * the personal root AND auto-shared (copied) into that org folder after analysis
 * settles, so teammates see it immediately while the user keeps their own copy.
 */
export interface DefaultSaveLocation {
  scope: "personal" | "org";
  /** Target org id when scope === "org". */
  orgId?: string | null;
  /** Target folder id within the scope, or null for the scope's root. */
  folderId: string | null;
}

/**
 * Which live delivery-coaching signals are active. All scored on the user's own
 * mic ("me") only (issue #22). Pace + pauses are free (timing/DSP) so default on;
 * pitch (monotony) and tone (an LLM call) are opt-in.
 */
export interface DeliveryToggles {
  /** Speech-rate gauge + "slow down" nudge (derived from transcript timing). */
  pace: boolean;
  /** Pitch-variation gauge + "you've gone flat" nudge (Rust F0 DSP). */
  pitch: boolean;
  /** Pause / silence / talk-time signals + steamroll / dead-air nudges. */
  pauses: boolean;
  /** LLM-judged delivery: aggressive/rude tone + over-frequent filler words.
   *  An extra, cheap eval call; also drives the post-call delivery section. */
  tone: boolean;
}

/**
 * Live prosody metrics for the "me" mic stream, mapped from the backend
 * `audio://prosody` event. Pitch/pause fields come from the Rust DSP analyzer;
 * `null` in the store until the first event of a meeting arrives.
 */
export interface ProsodyMetrics {
  /** Latest voiced pitch in Hz (0 while unvoiced). */
  f0Hz: number;
  /** Std-dev of F0 (semitones) over the rolling window — the monotony signal. */
  pitchVarSemitones: number;
  /** Convenience 0..1 (1 = very monotone); 0 until enough voiced frames. */
  monotonyScore: number;
  /** Mic-anchored speech rate (syllable nuclei per second) over the window. */
  speechRateHz: number;
  /** Fraction of the window that was voiced (0..1). */
  voicedRatio: number;
  /** Current trailing silence in ms (0 while speaking). */
  silenceMs: number;
  /** Longest pause within the window in ms. */
  longestPauseMs: number;
  /** Whether the most recent frame was voiced. */
  speaking: boolean;
  /** One-shot edge: a filled pause ("um/uh/呃/痾") was just detected acoustically
   *  (STT drops these, so this mic-derived flag is the only source). */
  filledPause: boolean;
}

/** Kind of live delivery nudge surfaced to the speaker (see DeliveryNudge). */
export type DeliveryNudgeKind =
  | "pace"
  | "monotone"
  | "steamroll"
  | "deadair"
  | "tone"
  | "filler"
  | "filledpause";

/** A transient, peripheral coaching nudge shown mid-call. */
export interface DeliveryNudge {
  kind: DeliveryNudgeKind;
  /** Localized one-liner, e.g. "Slow down" / "Your tone is sharpening". */
  message: string;
  /** Severity drives the accent color (info = gentle, warn = stronger). */
  severity: "info" | "warn";
  /** Optional short evidence (used by the tone nudge: the quoted phrase). */
  evidence?: string;
}

/** Tone bands, ordered mild → hostile. "firm" is healthy pushback, not a problem. */
export type ToneVerdict = "neutral" | "warm" | "firm" | "sharp" | "aggressive" | "rude";

/**
 * Filler-word / verbal-tic assessment of the user's own speech. By design we only
 * distinguish "ok" from "frequent": everyone uses some fillers, so mere presence
 * is never flagged — only an unusually dense stretch is.
 */
export interface FillerAssessment {
  /** "frequent" only when fillers are dense enough to distract; else "ok". */
  level: "ok" | "frequent";
  /** The actual tics observed (e.g. ["就是", "然後"] / ["um", "like"]). */
  examples: string[];
  /** Short human note about the dense stretch; empty when level is "ok". */
  note: string;
}

/**
 * The user's delivery assessment from the LLM pass — tone + filler frequency +
 * an overall one-liner. Computed live (rolling, over recent speech) and once
 * post-call (whole transcript). Always about the USER's own speech (issue #22).
 */
export interface DeliveryAssessment {
  tone: ToneVerdict;
  /** A short verbatim quote backing the tone read; empty if none. */
  toneEvidence: string;
  fillers: FillerAssessment;
  /** Overall speaking pace read (mainly meaningful post-call). */
  pace?: "slow" | "comfortable" | "fast";
  /** One-line plain-language summary of how the user is coming across. */
  summary: string;
}
