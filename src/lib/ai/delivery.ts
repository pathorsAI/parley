import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { transcriptAsText, useStore, meetingBriefText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext, outputLanguageInstruction } from "./profile";
import { fillerWatchlist } from "../analysis/fillerWords";
import { fillPrompt, meetingContextBlock, STUDY } from "./studyPrompt";
import type {
  DeliveryAssessment,
  ProsodyMetrics,
  Settings,
  ToneVerdict,
  TranscriptSegment,
} from "../types";

/** Tone verdicts that warrant a live nudge to soften delivery. */
export const TONE_FLAGGED: ReadonlySet<ToneVerdict> = new Set<ToneVerdict>([
  "sharp",
  "aggressive",
  "rude",
]);

const schema = z.object({
  tone: z
    .enum(["neutral", "warm", "firm", "sharp", "aggressive", "rude"])
    .describe("Overall tone of YOUR OWN most recent contributions — not the other party's."),
  tone_evidence: z
    .string()
    .describe("A short verbatim quote from YOUR OWN words that shows the tone; empty if none."),
  filler_level: z
    .enum(["ok", "frequent"])
    .describe(
      "'frequent' ONLY when filler words / verbal tics are dense enough in a short stretch to " +
        "distract (e.g. many in a sentence or two). Everyone uses some fillers — never flag mere " +
        "presence; default to 'ok'."
    ),
  filler_examples: z
    .array(z.string())
    .describe("The specific tics you actually heard the user overuse (e.g. ['就是','然後'] / ['um','like']); [] when ok."),
  filler_note: z
    .string()
    .describe("One short line about the over-frequent stretch (where/what); empty when level is 'ok'."),
  pace: z
    .enum(["slow", "comfortable", "fast"])
    .describe("How fast the user is speaking overall."),
  summary: z
    .string()
    .describe("One short plain-language line on how the user is coming across right now."),
});

/** How far back the LIVE check looks (ms). Whole transcript is used post-call. */
const LIVE_RECENT_MS = 30_000;

/** The system prompt — text in shared/prompts/study.json (`delivery.*`). */
const SYSTEM = (live: boolean) =>
  fillPrompt(STUDY.delivery.systemTemplate, { setting: STUDY.delivery.setting[live ? "live" : "post"] }) +
  JSON_MODE_INSTRUCTION;

/**
 * Assess the user's delivery (tone + over-frequent fillers + pace) over their own
 * recent speech (live) or the whole transcript (post-call). Works in diarized
 * "mix" sessions too: it identifies the user semantically via the profile, like
 * the timeline/eval calls — there is no per-source "me" in diarized transcripts.
 *
 * Returns null when there isn't enough speech to judge. Live callers gate this
 * behind the `delivery.tone` opt-in + a cooldown (see useAnalysisEngine); the
 * post-call runner calls it once over the full recording.
 */
export async function analyzeDelivery(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  prosody?: ProsodyMetrics | null;
  /** Whole-recording acoustic speech rate (syllables/sec) for the POST pass, where
   *  there's no live prosody stream — keeps the LLM's pace/summary honest. */
  measuredRateHz?: number | null;
  /** "live" trims to recent speech + cheaper prompt; "post" uses the whole call. */
  mode?: "live" | "post";
  /** Cancels the pass (the run was superseded). The call also has its own
   *  deadline — see generateObjectResilient. */
  signal?: AbortSignal;
}): Promise<DeliveryAssessment | null> {
  const { settings, segments, names, prosody, measuredRateHz, mode = "live", signal } = opts;
  const finals = segments.filter((s) => s.isFinal && s.text.trim());
  if (finals.length === 0) return null;

  let scope = finals;
  if (mode === "live") {
    const maxEnd = finals.reduce((m, s) => Math.max(m, s.endMs), 0);
    scope = finals.filter((s) => s.endMs >= maxEnd - LIVE_RECENT_MS);
  }
  const transcript = transcriptAsText(scope, names);
  if (!transcript.trim()) return null;

  const D = STUDY.delivery;
  const mc = meetingBriefText(useStore.getState());
  let delivery = "";
  if (prosody) {
    delivery = fillPrompt(D.prosodyTemplate, {
      rate: prosody.speechRateHz.toFixed(1),
      pitch: prosody.pitchVarSemitones.toFixed(1),
    });
  } else if (measuredRateHz) {
    delivery = fillPrompt(D.measuredRateTemplate, {
      rate: measuredRateHz.toFixed(1),
      perMinute: String(Math.round(measuredRateHz * 60)),
    });
  }
  const watchlist = fillPrompt(D.watchlistTemplate, { words: fillerWatchlist(settings.language).join(", ") });
  const ctx = profileContext(settings) + meetingContextBlock(mc) + delivery + watchlist;
  const label = D.transcriptLabel[mode];

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "realtime",
    schema,
    system: SYSTEM(mode === "live") + outputLanguageInstruction(settings),
    prompt: `${ctx}${label}:\n${transcript}`,
    signal,
  });
  void recordLlmUsage(settings, "realtime", "delivery", usage);

  return {
    tone: object.tone,
    toneEvidence: object.tone_evidence?.trim() ?? "",
    fillers: {
      level: object.filler_level,
      examples: (object.filler_examples ?? []).map((s) => s.trim()).filter(Boolean),
      note: object.filler_note?.trim() ?? "",
    },
    pace: object.pace,
    summary: object.summary?.trim() ?? "",
  };
}
