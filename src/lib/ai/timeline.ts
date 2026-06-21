import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { streamObjectResilient } from "./generate";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { log } from "../log";
import type { EvalDef, Settings, TimelineEvent, TranscriptSegment } from "../types";

// One notable moment the model surfaced. `time` is the [m:ss]/m:ss it cites; we
// parse it into atMs and fall back to fuzzy-matching the quote when it's unusable.
const eventSchema = z.object({
  time: z
    .string()
    .describe("The [m:ss] (or m:ss) time this moment occurred, copied from the transcript line."),
  side: z
    .enum(["me", "them"])
    .describe('"me" = a problem/mistake/missed move by ME; "them" = a substantive move by THEM.'),
  severity: z.enum(["info", "warn", "critical"]),
  source: z
    .enum(["eval", "extra"])
    .describe('"eval" when it matches one or more configured evaluations (set evalIds); "extra" otherwise.'),
  // Arrays (possibly empty), not nullable — a moment can match several evals and
  // cite several quotes. strict json_schema still has every property present.
  evalIds: z
    .array(z.string())
    .describe('Ids of EVERY configured evaluation this moment matches (a moment may match several); [] for "extra".'),
  title: z.string().describe("A short label for the moment."),
  detail: z.string().describe("One or two sentences explaining what happened and why it matters."),
  quotes: z
    .array(z.string())
    .describe(
      "Verbatim quote(s) anchoring this moment — usually one, but include MULTIPLE when they belong together " +
        "(e.g. BOTH sides of a contradiction, or a promise and its walk-back). [] if you have nothing exact."
    ),
  // Whether ME later took this moment on. Always present (false by default) so
  // strict json_schema and json_object (Groq) both keep the key.
  resolved: z
    .boolean()
    .describe(
      "true when, LATER in the conversation, ME actually responded to / addressed this moment — answered the " +
        "question, countered the pressure, corrected the misstep, or defused the risk. (Whether ME did it WELL is " +
        "judged elsewhere; here only whether ME took it on.) false if it was left unaddressed or you are unsure."
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

Work at the level of MEANINGFUL EXCHANGES, not individual sentences. Read the WHOLE conversation, then surface only the handful of moments that genuinely shaped the negotiation — a position taken, leverage, a constraint or concern raised, a concession, a real risk, or a mistake/missed move by ME. GROUP a back-and-forth on one topic into ONE moment, anchored at its most representative timestamp; do NOT emit a separate finding for each sentence or minor turn. Prefer a few high-signal findings over many granular ones.

For EACH moment provide:
- time: the [m:ss] it is best anchored to — copy a real timestamp from the transcript so ME can jump back.
- side: "them" for a substantive move BY THEM (a position, argument, demand, anchor, pressure, leverage, or a constraint/concern they raised); "me" for a problem/mistake/missed move BY ME.
- severity: info / warn / critical.
- source: "eval" when the moment matches one OR MORE configured evaluations — also set evalIds to EVERY eval id it genuinely matches. A single moment can match SEVERAL (e.g. a grand over-promise can be both "pushback" and "deception"). Do NOT force-fit: if it doesn't clearly fit any eval, use "extra" with evalIds [].
- evalIds: the matching evaluation ids (array — one, several, or [] for "extra").
- title: a short label for the dynamic (not a quote).
- detail: 1-2 sentences on the STRATEGIC substance — what is really going on (the underlying interest, leverage, risk, or move) and why it matters — so ME knows how to think about and negotiate it, not merely what was said.
- quotes: the verbatim line(s) that anchor it — usually one, but cite MULTIPLE when they belong together (e.g. BOTH sides of a contradiction, or a promise and its later walk-back). [] if you have nothing exact.
- resolved: true ONLY when, LATER in the transcript, ME actually responded to / addressed this moment — answered the question, countered the pressure, corrected MY own misstep, or defused the risk. false if it was left hanging, ignored, or you are unsure. (Mainly a "them" pressure/objection/risk that ME took on, but also a "me" misstep ME later fixed.)
- resolution: when resolved, ONE short line naming MY actual move and quoting/paraphrasing MY key words; "" when not resolved.

INTERPRET IN FULL CONTEXT — accuracy matters more than coverage:
- A neutral QUESTION or request from either side is NOT a claim, assertion, or pressure; never label it as one. Asking is not claiming.
- Do NOT mislabel a legitimate CONSTRAINT, concern, or honest disclosure as deception or inconsistency. Someone explaining a genuine conflict (e.g. "if I sign this as-is I'd breach a prior commitment") or changing approach for a stated reason is raising something to SOLVE — flag deception/inconsistency ONLY when the transcript genuinely shows a contradiction or misrepresentation in context.
- When THEM makes a strong point or a good proposal, surface it as a "them" moment so ME can think about how to respond — even if no eval targets it.
- If MY negotiation setup (BATNA / target / bottom line) is provided in the context, USE it: judge leverage and the ZOPA (zone of possible agreement) against it, separate interests from positions, prefer objective criteria over pressure, and flag when ME is being pushed toward MY bottom line.

RESOLVED MOMENTS: a problem ME already took on is not an open problem. When ME later answers, counters, corrects, or defuses a moment, set resolved + resolution so ME sees what was already handled (it is shown in GREEN). Be honest — mark resolved ONLY when the transcript really shows ME addressing it — but do NOT require the response to be perfect: mark it resolved if ME took it on at all; whether the response was strong enough is judged separately. A moment ME ignored or never came back to stays unresolved.

Be selective and ACCURATE. A short list of well-judged, strategic findings is far better than many literal ones. Ground everything in what was actually said; never fabricate quotes or timestamps.`;

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

/** Normalize for fuzzy matching: lowercase, strip non-alphanumerics. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

/** Find the segment whose text contains the quote (fuzzy). Returns its startMs. */
function startMsForQuote(quote: string | null | undefined, segments: TranscriptSegment[]): number | null {
  if (!quote) return null;
  const q = norm(quote);
  if (q.length < 4) return null;
  for (const s of segments) {
    if (!s.text.trim()) continue;
    const t = norm(s.text);
    if (t.includes(q) || q.includes(t)) return s.startMs;
  }
  return null;
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
  quotes?: (string | null)[] | null;
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
  const quotes = cleanStrings(e.quotes);
  // Time-anchor: trust the cited clock when plausible, else fuzzy-match a quote.
  let atMs = parseClockMs(e.time ?? undefined);
  if (atMs === null || atMs < 0 || (maxMs !== Infinity && atMs > maxMs + 5000)) {
    atMs = quotes.reduce<number | null>((acc, q) => acc ?? startMsForQuote(q, segments), null);
  }
  if (atMs === null) return null; // can't place it in time yet → drop

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
    quotes: quotes.length ? quotes : undefined,
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
  const system = (mode === "live" ? SYSTEM_INTRO_LIVE : SYSTEM_INTRO_REPLAY) + SYSTEM_BODY;
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
