import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions } from "./provider";
import { transcriptWithTimestamps } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
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
  evalId: z
    .string()
    .optional()
    .describe("The id of the matching evaluation when source is \"eval\"."),
  title: z.string().describe("A short label for the moment."),
  detail: z.string().describe("One or two sentences explaining what happened and why it matters."),
  quote: z.string().optional().describe("A verbatim quote from the transcript supporting this moment."),
});
const schema = z.object({ events: z.array(eventSchema) });

const SYSTEM = `You are doing a post-hoc RETRO of a finished negotiation/interview transcript for the user ("ME") against the other party ("THEM"). The conversation is OVER and you can see the whole thing.

You are given the user's ACTIVE EVALUATIONS (each with an id, a name, and what to look for) and the FULL timestamped transcript (every line is prefixed with its [m:ss] start time). Produce a chronological list of genuinely NOTABLE moments worth reviewing in a retro.

For EACH moment provide:
- time: the [m:ss] it occurred — copy a real timestamp from the transcript so the user can jump back to it.
- side: "me" if it's a problem/mistake/missed move by ME (e.g. I left a question unanswered, I conceded too early, I anchored badly); "them" if it's a point/argument/pressure/claim raised by THEM (e.g. they anchored hard on price, they made a verifiable claim, they applied pressure).
- severity: info / warn / critical.
- source: "eval" when the moment corresponds to one of the configured evaluations — also set evalId to that evaluation's id; otherwise "extra".
- title: a short label.
- detail: one or two sentences.
- quote: a VERBATIM quote from the transcript (never invent one — omit it if you have nothing exact).

Cover BOTH things the evaluations target AND important moments they DON'T (the "extra" ones the user didn't think to configure but should see in a retro). Be selective — surface the moments that genuinely matter, not every line. Ground everything in what was actually said; never fabricate quotes or timestamps.`;

/** Parse a model-supplied "[m:ss]" / "m:ss" / "h:mm:ss" time into milliseconds. */
function parseClockMs(raw: string | undefined): number | null {
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
function startMsForQuote(quote: string | undefined, segments: TranscriptSegment[]): number | null {
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
}): Promise<TimelineEvent[]> {
  const { settings, segments, evals, meetingContext, names } = opts;

  const transcript = transcriptWithTimestamps(segments, names);
  const ctx =
    profileContext(settings) +
    (meetingContext?.trim() ? `Meeting context: ${meetingContext.trim()}\n\n` : "");
  const list = evals.length
    ? evals.map((e) => `### id: ${e.id}\nname: ${e.name}\nwatch for: ${e.prompt}`).join("\n\n")
    : "(none configured)";

  const { object, usage } = await generateObject({
    model: getModel(settings, "eval"),
    providerOptions: getProviderOptions(settings, "eval"),
    schema,
    system: SYSTEM,
    prompt: `${ctx}Active evaluations:\n${list}\n\nFull transcript:\n${transcript || "(no speech was captured)"}`,
  });
  void recordLlmUsage(settings, "eval", "eval", usage);

  // Only treat evalId as valid if it actually matches a configured evaluation.
  const evalIds = new Set(evals.map((e) => e.id));
  const maxMs = segments.reduce((m, s) => Math.max(m, s.endMs), 0) || Infinity;

  const events: TimelineEvent[] = [];
  for (const e of object.events) {
    // Time-anchor: trust the cited clock when plausible, else fuzzy-match the quote.
    let atMs = parseClockMs(e.time);
    if (atMs === null || atMs < 0 || (maxMs !== Infinity && atMs > maxMs + 5000)) {
      atMs = startMsForQuote(e.quote, segments);
    }
    if (atMs === null) continue; // can't place it in time → drop

    const hasEval = e.source === "eval" && !!e.evalId && evalIds.has(e.evalId);
    events.push({
      id: crypto.randomUUID(),
      atMs: Math.max(0, atMs),
      side: e.side,
      severity: e.severity,
      source: hasEval ? "eval" : "extra",
      evalId: hasEval ? e.evalId : undefined,
      title: e.title,
      detail: e.detail,
      quote: e.quote?.trim() || undefined,
    });
  }

  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}
