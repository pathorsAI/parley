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
    .describe('"me" = a problem/mistake/missed move by ME; "them" = a point/argument/pressure/claim raised by THEM.'),
  severity: z.enum(["info", "warn", "critical"]),
  source: z
    .enum(["eval", "extra"])
    .describe('"eval" when this matches one of the configured evaluations (set evalId too); "extra" otherwise.'),
  // .nullable() (not .optional()): strict json_schema structured outputs require
  // every property to be present in `required`. Downstream code is null-safe.
  evalId: z
    .string()
    .nullable()
    .describe("The id of the matching evaluation when source is \"eval\", else null."),
  title: z.string().describe("A short label for the moment."),
  detail: z.string().describe("One or two sentences explaining what happened and why it matters."),
  quote: z
    .string()
    .nullable()
    .describe("A verbatim quote from the transcript supporting this moment, or null."),
});
const schema = z.object({ events: z.array(eventSchema) });

const SYSTEM_INTRO_REPLAY = `You are doing a post-hoc RETRO of a finished negotiation/interview transcript for the user ("ME") against the other party ("THEM"). The conversation is OVER and you can see the whole thing.`;

const SYSTEM_INTRO_LIVE = `You are analyzing an ONGOING negotiation/interview for the user ("ME") against the other party ("THEM"). The meeting is STILL IN PROGRESS — you see only what has been said SO FAR. Surface the notable moments up to now so ME can course-correct in real time.`;

const SYSTEM_BODY = `

You are given the user's ACTIVE EVALUATIONS (each with an id, a name, and what to look for) and the timestamped transcript (every line is prefixed with its [m:ss] start time). Produce a chronological list of genuinely NOTABLE moments worth reviewing.

For EACH moment provide:
- time: the [m:ss] it occurred — copy a real timestamp from the transcript so the user can jump back to it.
- side: "me" if it's a problem/mistake/missed move by ME (e.g. I left a question unanswered, I conceded too early, I anchored badly); "them" if it's a point/argument/pressure/claim raised by THEM (e.g. they anchored hard on price, they made a verifiable claim, they applied pressure).
- severity: info / warn / critical.
- source: "eval" when the moment corresponds to one of the configured evaluations — also set evalId to that evaluation's id; otherwise "extra".
- title: a short label.
- detail: one or two sentences.
- quote: a VERBATIM quote from the transcript (never invent one — omit it if you have nothing exact).

Cover BOTH things the evaluations target AND important moments they DON'T (the "extra" ones the user didn't think to configure but should see). Be selective — surface the moments that genuinely matter, not every line. Ground everything in what was actually said; never fabricate quotes or timestamps.`;

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
  evalId?: string | null;
  title?: string | null;
  detail?: string | null;
  quote?: string | null;
};

/**
 * Place ONE raw model event onto the timeline, or return null if it isn't ready
 * (still streaming → missing a rendered field, or can't be anchored in time). The
 * `id` is supplied by the caller so it stays stable across partial updates.
 */
function mapTimelineEvent(
  e: RawEvent,
  id: string,
  segments: TranscriptSegment[],
  evalIds: Set<string>,
  maxMs: number
): TimelineEvent | null {
  // Require the fields the UI renders so a half-streamed row never flashes blank.
  if (!e.side || !e.severity || !e.title || !e.detail) return null;
  // Time-anchor: trust the cited clock when plausible, else fuzzy-match the quote.
  let atMs = parseClockMs(e.time ?? undefined);
  if (atMs === null || atMs < 0 || (maxMs !== Infinity && atMs > maxMs + 5000)) {
    atMs = startMsForQuote(e.quote, segments);
  }
  if (atMs === null) return null; // can't place it in time yet → drop

  const hasEval = e.source === "eval" && !!e.evalId && evalIds.has(e.evalId);
  return {
    id,
    atMs: Math.max(0, atMs),
    side: e.side,
    severity: e.severity,
    source: hasEval ? "eval" : "extra",
    evalId: hasEval ? e.evalId ?? undefined : undefined,
    title: e.title,
    detail: e.detail,
    quote: e.quote?.trim() || undefined,
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
      const placed = placeEvents((p as { events?: (RawEvent | undefined)[] }).events);
      if (placed.length === emittedCount) return;
      emittedCount = placed.length;
      onPartial(placed);
    },
  }).catch((e) => {
    log.error("ai.timeline: failed", { provider, model, error: String(e) });
    throw e;
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  const events = placeEvents(object.events);
  log.info("ai.timeline: ok", { raw: object.events.length, placed: events.length });
  return events;
}
