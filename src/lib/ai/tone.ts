import { z } from "zod";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { generateObjectResilient } from "./generate";
import { transcriptAsText, useStore, meetingBriefText } from "../store";
import { recordLlmUsage } from "../usage/log";
import { profileContext } from "./profile";
import type { ProsodyMetrics, Settings, TranscriptSegment } from "../types";

/** Tone bands, ordered mild → hostile. "firm" is healthy pushback, not a problem. */
export type ToneVerdict = "neutral" | "warm" | "firm" | "sharp" | "aggressive" | "rude";

/** Verdicts that warrant a live nudge to soften delivery. */
export const TONE_FLAGGED: ReadonlySet<ToneVerdict> = new Set<ToneVerdict>([
  "sharp",
  "aggressive",
  "rude",
]);

const schema = z.object({
  tone: z
    .enum(["neutral", "warm", "firm", "sharp", "aggressive", "rude"])
    .describe("Overall tone of YOUR OWN most recent contributions — not the other party's."),
  nudge: z
    .string()
    .describe(
      "Only when tone is sharp/aggressive/rude: a short corrective hint to yourself " +
        "(≤6 words, imperative, in the transcript's language), e.g. 'Soften your wording'. Empty otherwise."
    ),
  evidence: z
    .string()
    .describe("A short verbatim quote from YOUR OWN words that shows the tone; empty if none."),
});

export interface ToneResult {
  tone: ToneVerdict;
  nudge: string;
  evidence: string;
}

/** How far back to look for the user's recent speech (ms). Keeps the call cheap. */
const RECENT_MS = 30_000;

/**
 * Judge the tone of the USER'S OWN recent speech (aggressive / rude / sharp …) so
 * the live coach can nudge them to soften. Works in diarized "mix" sessions too:
 * it relies on the profile to identify the user semantically, exactly like the
 * timeline/eval calls — there is no per-source "me" in diarized transcripts.
 *
 * Returns null when there isn't enough recent speech to judge. This is an extra,
 * deliberately small LLM call (short context, cheap "ask" model role); the engine
 * gates it behind the `delivery.tone` opt-in + a cooldown (see useAnalysisEngine).
 */
export async function analyzeTone(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  names?: Record<string, string>;
  prosody?: ProsodyMetrics | null;
}): Promise<ToneResult | null> {
  const { settings, segments, names, prosody } = opts;
  const finals = segments.filter((s) => s.isFinal && s.text.trim());
  if (finals.length === 0) return null;

  const maxEnd = finals.reduce((m, s) => Math.max(m, s.endMs), 0);
  const recent = finals.filter((s) => s.endMs >= maxEnd - RECENT_MS);
  const transcript = transcriptAsText(recent, names);
  if (!transcript.trim()) return null;

  const mc = meetingBriefText(useStore.getState()).trim();
  // Fold in the mic-derived delivery signals so the model can reason about how it
  // was said, not just the words (e.g. fast + sharp wording reads more aggressive).
  const delivery = prosody
    ? `Your delivery signals: ~${prosody.speechRateHz.toFixed(1)} syllables/sec, ` +
      `pitch variation ${prosody.pitchVarSemitones.toFixed(1)} semitones.\n\n`
    : "";
  const ctx = profileContext(settings) + (mc ? `Meeting context: ${mc}\n\n` : "") + delivery;

  const { object, usage } = await generateObjectResilient({
    settings,
    kind: "ask",
    schema,
    system:
      "You are a real-time delivery coach for the user in a live conversation. " +
      "From the recent transcript, judge the tone of the USER'S OWN words only — never the other party's. " +
      "Use the profile to tell which speaker is the user. Reserve 'aggressive' / 'rude' for genuinely hostile, " +
      "demeaning, dismissive, or contemptuous wording; firm disagreement or pushback is 'firm', not aggressive. " +
      "When uncertain, prefer the milder label. Keep the nudge short, kind, and actionable." +
      JSON_MODE_INSTRUCTION,
    prompt: `${ctx}Recent transcript:\n${transcript}`,
  });
  void recordLlmUsage(settings, "ask", "tone", usage);

  return {
    tone: object.tone,
    nudge: object.nudge?.trim() ?? "",
    evidence: object.evidence?.trim() ?? "",
  };
}
