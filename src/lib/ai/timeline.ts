import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { log } from "../log";
import type { EvalDef, Settings, TimelineEvent, TranscriptSegment } from "../types";

// One notable moment the model surfaced. `time` is the [m:ss]/m:ss it cites; we
// parse it into atMs and snap it to the exact transcript segment — the timestamp
// IS the anchor, so no verbatim quote needs generating.
const eventSchema = z.object({
  time: z
    .string()
    .describe(
      "The [m:ss] (or m:ss) time this moment is anchored to — copy a REAL timestamp " +
        "EXACTLY from the transcript line it refers to. This is the only anchor, so it must be accurate."
    ),
  side: z
    .enum(["me", "them"])
    .describe(
      `"them" = a substantive move BY THEM (a position, argument, demand, anchor, pressure, leverage, or a constraint/concern they raised — INCLUDING a THEM objection/pressure ME later rebutted, which stays "them" even though rebutting it was ME's good move); "me" = a problem/mistake/missed move BY ME (including one ME later corrected). Attribute by WHOSE move it was, never by who came out ahead.`
    ),
  severity: z
    .enum(["info", "warn", "critical"])
    .describe(
      `How much this moment matters. For a resolved win, judge severity by the STAKES the challenge would have had IF UNHANDLED — a resolved finding already renders GREEN, so do not wash it down to "info".`
    ),
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
});
// The wrapper key is "moments" to match the prompt's vocabulary ("notable
// moments") — in json_object mode (Groq) the key isn't server-enforced, so a
// mismatch makes the model emit its own key and the parse fails. Keep them aligned.
const schema = z.object({ moments: z.array(eventSchema) });

const SYSTEM_INTRO_REPLAY = `You are doing a post-hoc RETRO of a finished negotiation/interview transcript for the user ("ME") against the other party ("THEM"). The conversation is OVER and you can see the whole thing.`;

const SYSTEM_INTRO_LIVE = `You are analyzing an ONGOING negotiation/interview for the user ("ME") against the other party ("THEM"). The meeting is STILL IN PROGRESS — you see only what has been said SO FAR. Surface the notable moments up to now so ME can course-correct in real time.`;

const SYSTEM_BODY = `

You are given the user's ACTIVE EVALUATIONS (each with an id, a name, and what to look for) and the full timestamped transcript (every line is prefixed with its [m:ss] start time).

Work at the level of MEANINGFUL EXCHANGES, not individual sentences. Read the conversation, then surface only the handful of moments that genuinely shaped the negotiation — a position taken, leverage, a constraint or concern raised, a concession, a real risk, a mistake/missed move by ME, OR a real challenge/objection/pressure/risk from THEM that ME meaningfully handled (a WIN worth recording — surface it as a resolved moment; see RESOLVED MOMENTS). A win counts ONLY when there was genuine tension for ME to defuse AND ME actually reduced the risk — never ME merely replying, answering a neutral question, being agreeable, or saying something pleasant. GROUP a back-and-forth on one topic into ONE moment, anchored at its most representative timestamp; do NOT emit a separate finding for each sentence or minor turn — a mistake by ME and ME's own later meaningful repair are ONE resolved moment, never two. Prefer a few high-signal findings over many granular ones, and surface open/unresolved problems and risks FIRST: wins are ADDITIONAL, never a substitute for an open problem and never take its slot.

For EACH moment provide:
- time: the [m:ss] it is best anchored to — copy a REAL timestamp EXACTLY from the transcript line it refers to. This is the ONLY anchor (there are no quotes), so it must be accurate enough for ME to jump straight to that line.
- side: "them" for a substantive move BY THEM (a position, argument, demand, anchor, pressure, leverage, or a constraint/concern they raised); "me" for a problem/mistake/missed move BY ME.
- severity: info / warn / critical.
- source: "eval" when the moment matches one OR MORE configured evaluations — also set evalIds to EVERY eval id it genuinely matches. A single moment can match SEVERAL (e.g. a grand over-promise can be both "pushback" and "deception"). Do NOT force-fit: if it doesn't clearly fit any eval, use "extra" with evalIds [].
- evalIds: the matching evaluation ids (array — one, several, or [] for "extra").
- title: a short label for the dynamic (not a quote).
- detail: 1-2 sentences on the STRATEGIC substance — what is really going on (the underlying interest, leverage, risk, missed exploration, or move) and why it matters — so ME knows how to think about and negotiate it, not merely what was said.
- resolved: true ONLY when ME meaningfully mitigated / repaired this moment — explored the concern, protected leverage, traded for value, corrected MY own misstep, or otherwise reduced the risk. false if ME merely replied, gave an unexplored concession, accepted the premise, left it hanging, ignored it, or you are unsure. (Mainly a "them" pressure/objection/risk that ME handled well enough to reduce, but also a "me" misstep ME later fixed.)
- resolution: when resolved, ONE short line naming MY actual move and quoting/paraphrasing MY key words; "" when not resolved.

INTERPRET IN FULL CONTEXT — accuracy matters more than coverage:
- A neutral QUESTION or request from either side is NOT a claim, assertion, or pressure; never label it as one. Asking is not claiming.
- Do NOT mislabel a legitimate CONSTRAINT, concern, or honest disclosure as deception or inconsistency. Someone explaining a genuine conflict (e.g. "if I sign this as-is I'd breach a prior commitment") or changing approach for a stated reason is raising something to SOLVE — flag deception/inconsistency ONLY when the transcript genuinely shows a contradiction or misrepresentation in context.
- When THEM makes a strong point or a good proposal, surface it as a "them" moment so ME can think about how to respond — even if no eval targets it.
- If MY negotiation setup (BATNA / target / bottom line) is provided in the context, USE it: judge leverage and the ZOPA (zone of possible agreement) against it, separate interests from positions, prefer objective criteria over pressure, and flag when ME is being pushed toward MY bottom line.

RESOLVED MOMENTS — record what ME meaningfully handled, do NOT drop it. A real challenge ME reduced is a WIN worth showing precisely BECAUSE handling it is what ME should see; when ME later explores, counters with substance, trades for value, corrects, repairs, or defuses a moment, set resolved + resolution and it renders GREEN. Keep its side by WHOSE move it was, never by who came out ahead: a THEM objection/pressure/risk ME mitigated stays "them" + resolved; a ME misstep ME repaired stays "me" + resolved. Be strict — a reply alone is NOT resolution. Do NOT mark resolved when ME simply answered, changed the number/position, conceded, accepted pressure, or moved on without exploring the other side's interest/rationale. You MUST judge whether MY response meaningfully reduced the risk; if it did not, keep the underlying problem unresolved and set severity by its stakes. For example, if THEM says "6000 is too high" and ME immediately drops to 4500 without probing budget, criteria, priorities, or a trade, that is likely a serious unresolved ME concession/missed-exploration issue, NOT resolved. If you cannot name MY meaningful mitigating move in the resolution line, it is not resolved. In a still-in-progress meeting, mark resolved ONLY once ME has clearly finished a meaningful mitigation; a reply still unfolding stays unresolved. A moment ME ignored or never came back to stays unresolved.

Be selective and ACCURATE. A short list of well-judged, strategic findings is far better than many literal ones. Ground everything in what was actually said; never fabricate timestamps — every time must be copied from a real transcript line.`;

const LIVE_MODE_INSTRUCTIONS = `

MODE: REALTIME / IN-PROGRESS ANALYSIS.
- Treat this as coaching while ME can still change the conversation. Highlight red/critical risks when warranted, but write detail so it points to the NEXT useful move: what ME should ask, clarify, slow down, protect, or trade next.
- Prefer open, actionable findings over retrospective praise. A severe live issue should remain visible until ME has meaningfully mitigated it.
- Do not use hindsight language; this transcript contains only what has been said so far.`;

const REPLAY_MODE_INSTRUCTIONS = `

MODE: POST-EVALUATION / RETROSPECTIVE ANALYSIS.
- The conversation is over. Be direct about what went wrong, where MY response was weak, what leverage or information ME failed to explore, and what ME should learn for next time.
- You may use later counterparty behavior as hindsight evidence, but label it as hindsight in the detail when it matters (for example: "In hindsight, their later budget comment suggests this should have been probed here.").
- Do not convert a bad response into a green/resolved card merely because ME replied; unresolved mistakes and weak concessions should stay warn/critical.`;

/** Parse a model-supplied "[m:ss]" / "m:ss" / "h:mm:ss" time into milliseconds. */
export function parseClockMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  // [h:mm:ss] vs [m:ss]
  const totalSec = c !== null ? a * 3600 + b * 60 + c : a * 60 + b;
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
  maxMs: number
): TimelineEvent | null {
  // Require the fields the UI renders so a half-streamed row never flashes blank.
  if (!e.side || !e.severity || !e.title || !e.detail) return null;
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
  const resolved = e.resolved === true && resolution.length > 0;
  return {
    id,
    atMs: Math.max(0, atMs),
    side: e.side,
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
  /** Called with the cumulative placed findings as they stream in (for live UI). */
  onPartial?: (events: TimelineEvent[]) => void;
}): Promise<TimelineEvent[]> {
  const { settings, segments, evals, meetingContext, names, mode = "replay", onPartial } = opts;

  const transcript = transcriptWithTimestamps(segments, names);
  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");
  const list = evals.length
    ? evals.map((e) => `### id: ${e.id}\nname: ${e.name}\nwatch for: ${e.prompt}`).join("\n\n")
    : "(none configured)";
  const system =
    (mode === "live" ? SYSTEM_INTRO_LIVE : SYSTEM_INTRO_REPLAY) +
    SYSTEM_BODY +
    (mode === "live" ? LIVE_MODE_INSTRUCTIONS : REPLAY_MODE_INSTRUCTIONS);
  const transcriptLabel = mode === "live" ? "Transcript so far" : "Full transcript";

  const provider = settings.provider;
  const model = settings.models[settings.provider].eval;
  log.info("ai.timeline: start", { provider, model, segments: segments.length, evals: evals.length });

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
      const ev = e ? mapTimelineEvent(e, idAt(i), segments, evalIds, maxMs) : null;
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
    kind: "eval",
    schema,
    system: system + JSON_MODE_INSTRUCTION + outputLanguageInstruction(settings),
    prompt: `${ctx}Active evaluations:\n${list}\n\n${transcriptLabel}:\n${transcript || "(no speech was captured)"}`,
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
  void recordLlmUsage(settings, "eval", "eval", usage);

  const events = placeEvents(object.moments);
  log.info("ai.timeline: ok", { raw: object.moments.length, placed: events.length });
  return events;
}
