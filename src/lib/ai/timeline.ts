import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import {
  DECISION_CATEGORIES,
  findingsFieldGuide,
  findingsIntro,
  hasCategories,
  hasResolution,
  hasSides,
} from "../analysis/lens";
import { log } from "../log";
import { fillPrompt, meetingContextBlock, STUDY } from "./studyPrompt";
import type {
  AnalysisLens,
  EvalDef,
  FindingCategory,
  Settings,
  TimelineEvent,
  TranscriptSegment,
} from "../types";

// One notable moment the model surfaced. `time` is the [m:ss]/m:ss it cites; we
// parse it into atMs and snap it to the exact transcript segment — the timestamp
// IS the anchor, so no verbatim quote needs generating.
//
// The shape is LENS-DEPENDENT: a working-meeting record has no me/them lane and
// nothing to "resolve", so those fields are not merely left empty — they are not
// asked for at all. Asking a model for a field that makes no sense is how the
// decision lens used to come back reading like a negotiation scorecard.
const baseShape = {
  time: z
    .string()
    .describe(
      "The [m:ss] (or m:ss) time this moment is anchored to — copy a REAL timestamp " +
        "EXACTLY from the transcript line it refers to. This is the only anchor, so it must be accurate."
    ),
  severity: z
    .enum(["info", "warn", "critical"])
    .describe("How much this moment matters."),
  source: z
    .enum(["eval", "extra"])
    .describe('"eval" when it matches one or more configured evaluations (set evalIds); "extra" otherwise.'),
  // Array (possibly empty), not nullable — a moment can match several evals.
  // strict json_schema still has every property present.
  evalIds: z
    .array(z.string())
    .describe('Ids of EVERY configured evaluation this moment matches (a moment may match several); [] for "extra".'),
  title: z.string().describe("A short label for the moment."),
  detail: z.string().describe("One or two sentences explaining what happened and why it matters."),
};

const sideField = z
  .enum(["me", "them"])
  .describe(
    'Whose move this was. Attribute by WHOSE move it was, never by who came out ahead — ' +
      'a THEM objection ME later answered is still "them".'
  );

const categoryField = z
  .enum(DECISION_CATEGORIES)
  .describe(
    '"decision" when the meeting SETTLED something, "open" when it was raised and left unresolved, ' +
      '"fact" for information established that is neither.'
  );

const resolvedFields = {
  // Whether ME later took this moment on. Always present (false by default) so
  // strict json_schema and json_object (Groq) both keep the key.
  resolved: z
    .boolean()
    .describe(
      "true ONLY when ME meaningfully mitigated / repaired this moment — explored the concern, protected leverage, " +
        "traded for value, corrected the misstep, or otherwise reduced the risk. A reply by itself is NOT resolution; " +
        "a weak answer, unexplored concession, or ignored concern stays unresolved."
    ),
  resolution: z
    .string()
    .describe(
      'When resolved, ONE short line on HOW ME handled it — name MY actual move and quote/paraphrase MY key words. "" when not resolved.'
    ),
};

/** The moment schema this lens asks for. The wrapper key is "moments" to match
 *  the prompt's vocabulary — in json_object mode (Groq) the key isn't
 *  server-enforced, so a mismatch makes the model emit its own key and the parse
 *  fails. Keep them aligned. */
function schemaFor(lens: AnalysisLens) {
  const shape = {
    ...baseShape,
    ...(hasSides(lens) ? { side: sideField } : {}),
    ...(hasCategories(lens) ? { category: categoryField } : {}),
    ...(hasResolution(lens) ? resolvedFields : {}),
  };
  return z.object({ moments: z.array(z.object(shape)) });
}

/**
 * Build the whole system prompt for one lens + mode from the fragments in
 * shared/prompts/study.json (`timeline.*`). The resolved/resolution field notes
 * and the RESOLVED MOMENTS block only exist under the adversarial lens — the
 * same lens whose schema asks for those fields.
 */
function buildSystem(lens: AnalysisLens, mode: "live" | "replay"): string {
  const T = STUDY.timeline;
  return fillPrompt(T.systemTemplate, {
    intro: findingsIntro(lens, mode),
    selectionRule: T.selectionRule[lens],
    fieldGuide: findingsFieldGuide(lens),
    severityRule: T.severityRule[lens],
    resolvedFields: hasResolution(lens) ? T.resolvedFields : "",
    interpretation: T.interpretation[lens],
    resolvedBlock: hasResolution(lens) ? T.resolvedBlock : "",
    modeBlock: T.mode[mode][lens],
  });
}

// Any number of leading digits: a meeting past 100 minutes is cited as
// "[102:30]", which a two-digit cap would read as 2:30.
const CLOCK_RE = /(\d{1,4}):(\d{2})(?::(\d{2}))?/;

/** Parse a model-supplied "[m:ss]" / "m:ss" / "h:mm:ss" time into milliseconds. */
export function parseClockMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = CLOCK_RE.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] === undefined ? null : Number(m[3]);
  // [m:ss] vs [h:mm:ss]
  const totalSec = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  if (!Number.isFinite(totalSec)) return null;
  return totalSec * 1000;
}

/**
 * Snap a parsed clock (second-precision) to a real transcript segment. Each line
 * is displayed with `formatClock(startMs)`, so when the model copies a line's
 * [m:ss] the parse floors it to the second — match the line that DISPLAYS that
 * exact clock so the jump + highlight land on it. Fall back to the line in
 * progress at that time, then the nearest line, then the raw value.
 */
function snapToSegment(atMs: number, segments: TranscriptSegment[]): number {
  let exact: number | null = null; // line whose [m:ss] equals the cited clock
  let active: number | null = null; // line in progress at atMs
  let nearest: number | null = null;
  let nearestDelta = Infinity;
  for (const s of segments) {
    if (!s.text.trim()) continue;
    if (exact === null && s.startMs >= atMs && s.startMs < atMs + 1000) exact = s.startMs;
    if (s.startMs <= atMs && atMs <= s.endMs) active = s.startMs;
    const d = Math.abs(s.startMs - atMs);
    if (d < nearestDelta) {
      nearestDelta = d;
      nearest = s.startMs;
    }
  }
  return exact ?? active ?? nearest ?? atMs;
}

/** A (possibly half-streamed) raw event from the model — every field may be absent. */
type RawEvent = {
  time?: string | null;
  side?: "me" | "them";
  category?: FindingCategory;
  severity?: "info" | "warn" | "critical";
  source?: "eval" | "extra";
  evalIds?: (string | null)[] | null;
  title?: string | null;
  detail?: string | null;
  resolved?: boolean | null;
  resolution?: string | null;
};

/** Keep only non-empty trimmed strings from a (possibly partial) array. */
function cleanStrings(arr: (string | null)[] | null | undefined): string[] {
  return (arr ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
}

/**
 * Place ONE raw model event onto the timeline, or return null if it isn't ready
 * (still streaming → missing a rendered field, or can't be anchored in time). The
 * `id` is supplied by the caller so it stays stable across partial updates.
 */
function mapTimelineEvent(
  e: RawEvent,
  id: string,
  segments: TranscriptSegment[],
  validEvalIds: Set<string>,
  maxMs: number,
  lens: AnalysisLens
): TimelineEvent | null {
  // Require the fields the UI renders so a half-streamed row never flashes blank —
  // which fields those are depends on the lens (a decision finding has no side).
  if (!e.severity || !e.title || !e.detail) return null;
  if (hasSides(lens) && !e.side) return null;
  if (hasCategories(lens) && !e.category) return null;
  // Time-anchor purely on the cited clock — it's the sole anchor now. Drop the
  // moment if it's missing or out of range (still streaming, or a bad timestamp).
  const parsed = parseClockMs(e.time ?? undefined);
  if (parsed === null || parsed < 0 || (maxMs !== Infinity && parsed > maxMs + 5000)) return null;
  // Snap to the real segment so the jump + transcript highlight land on the line
  // (and the second-precision rounding self-corrects to the exact startMs).
  const atMs = snapToSegment(parsed, segments);

  // Keep only eval ids that match a configured evaluation.
  const matchedEvalIds = cleanStrings(e.evalIds).filter((x) => validEvalIds.has(x));
  const isEval = e.source === "eval" && matchedEvalIds.length > 0;
  // Only treat as resolved when ME actually has a "how" to show — a resolved flag
  // with no resolution text is useless (and ambiguous), so fall back to the
  // severity state in that case.
  const resolution = typeof e.resolution === "string" ? e.resolution.trim() : "";
  const resolved = hasResolution(lens) && e.resolved === true && resolution.length > 0;
  return {
    id,
    atMs: Math.max(0, atMs),
    side: hasSides(lens) ? e.side : undefined,
    category: hasCategories(lens) ? e.category : undefined,
    severity: e.severity,
    source: isEval ? "eval" : "extra",
    evalIds: isEval ? matchedEvalIds : undefined,
    title: e.title,
    detail: e.detail,
    resolved: resolved || undefined,
    resolution: resolved ? resolution : undefined,
  };
}

/**
 * Whole-recording retro analysis. Runs over the FULL transcript (NOT masked) and
 * returns time-anchored findings for the replay timeline. Each finding is tagged
 * "eval" (matching a configured evaluation) or "extra" (an AI-caught moment), and
 * sided "me"/"them" to drive its lane.
 */
export async function analyzeTimeline(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  evals: EvalDef[];
  meetingContext?: string;
  names?: Record<string, string>;
  /** "replay" (default) frames the analysis as a finished retro; "live" as in-progress. */
  mode?: "live" | "replay";
  /** The output shape to ask for. Defaults to the decision lens — a plain record
   *  is the reading that is wrong in the least damaging way. */
  lens?: AnalysisLens;
  /** Called with the cumulative placed findings as they stream in (for live UI). */
  onPartial?: (events: TimelineEvent[]) => void;
  /** Cancels the pass (the run was superseded). The call also has its own
   *  deadline — see streamObjectResilient. */
  signal?: AbortSignal;
}): Promise<TimelineEvent[]> {
  const { settings, segments, evals, meetingContext, names, mode = "replay", lens = "decision", onPartial, signal } = opts;

  const transcript = transcriptWithTimestamps(segments, names);
  const T = STUDY.timeline;
  const ctx = profileContext(settings) + meetingContextBlock(meetingContext);
  const list = evals.length
    ? evals.map((e) => fillPrompt(T.evalEntry, { id: e.id, name: e.name, prompt: e.prompt })).join("\n\n")
    : T.noEvals;
  const system = buildSystem(lens, mode);
  const transcriptLabel = T.transcriptLabel[mode];

  // Live analysis is latency-sensitive; a replay pass buys quality instead.
  const workload = mode === "live" ? ("realtime" as const) : ("deep" as const);
  const provider = settings.llmProviders[workload];
  const model = settings.models[provider][workload];
  log.info("ai.timeline: start", { provider, model, lens, segments: segments.length, evals: evals.length });

  // Only treat evalId as valid if it actually matches a configured evaluation.
  const evalIds = new Set(evals.map((e) => e.id));
  const maxMs = segments.reduce((m, s) => Math.max(m, s.endMs), 0) || Infinity;
  // Stable id per array index so streamed rows keep their identity as the object
  // fills in — and the final list reuses the same ids (no re-key/flicker at end).
  const ids: string[] = [];
  const idAt = (i: number) => (ids[i] ??= crypto.randomUUID());

  const placeEvents = (raw: ReadonlyArray<RawEvent | undefined> | undefined): TimelineEvent[] => {
    const out: TimelineEvent[] = [];
    (raw ?? []).forEach((e, i) => {
      const ev = e ? mapTimelineEvent(e, idAt(i), segments, evalIds, maxMs, lens) : null;
      if (ev) out.push(ev);
    });
    out.sort((a, b) => a.atMs - b.atMs);
    return out;
  };

  // Only push to the store when a NEW finding becomes placeable (streamObject
  // emits a partial on every field delta; the placed list only grows as elements
  // complete) — avoids redundant store writes while a title streams in char-by-char.
  let emittedCount = -1;
  const { object, usage } = await streamObjectResilient({
    settings,
    workload,
    schema: schemaFor(lens),
    system: system + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}${T.evalsHeader}\n${list}\n\n${transcriptLabel}:\n${transcript || STUDY.noSpeech}`,
    signal,
    onPartial: (p) => {
      if (!onPartial) return;
      const placed = placeEvents((p as { moments?: (RawEvent | undefined)[] }).moments);
      if (placed.length === emittedCount) return;
      emittedCount = placed.length;
      onPartial(placed);
    },
  }).catch((e) => {
    log.error("ai.timeline: failed", { provider, model, error: String(e) });
    throw e;
  });
  void recordLlmUsage(settings, workload, "eval", usage);

  const events = placeEvents(object.moments as RawEvent[]);
  log.info("ai.timeline: ok", { raw: object.moments.length, placed: events.length });
  return events;
}
