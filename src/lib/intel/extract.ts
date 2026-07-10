import { z } from "zod";
import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateObjectResilient } from "../ai/generate";
import { log } from "../log";
import type { IntelState, MeetingType, TranscriptSegment } from "../types";

/**
 * Intelligence-board extraction: one LLM pass over the live transcript that
 * returns the ACCUMULATED state for the selected meeting type (negotiation
 * numbers ledger, sales objection tracker, partnership leverage map). Always
 * recomputed from the full transcript, so it self-corrects as context grows —
 * no incremental-merge bugs.
 */

const negotiationSchema = z.object({
  numbers: z.array(
    z.object({
      value: z.string().describe("the number/amount as said, e.g. $120, 500 units, 3 years"),
      speaker: z.enum(["me", "them"]),
      context: z.string().describe("what this number was about, under 10 words"),
    })
  ),
  concessionsMe: z.array(z.string()).describe("concessions MY side has made so far"),
  concessionsThem: z.array(z.string()).describe("concessions THEIR side has made so far"),
  agreed: z.array(z.string()).describe("terms both sides have agreed on"),
  open: z.array(z.string()).describe("terms raised but still unresolved"),
});

const salesSchema = z.object({
  budget: z.string().describe("budget signal if any was mentioned, else empty string"),
  timeline: z.string().describe("timeline/deadline signal if any, else empty string"),
  decisionMaker: z.string().describe("who decides, if it came up, else empty string"),
  objections: z.array(
    z.object({
      text: z.string().describe("the objection, under 15 words"),
      addressed: z.boolean().describe("was it substantively answered"),
    })
  ),
  commitments: z.array(
    z.object({ who: z.enum(["me", "them"]), what: z.string().describe("the commitment, under 15 words") })
  ),
  competitors: z.array(z.string()).describe("competitor names mentioned"),
});

const partnershipSchema = z.object({
  theyHave: z.array(z.string()).describe("assets/strengths the counterpart has (channels, users, tech, team)"),
  theyNeed: z.array(z.string()).describe("things the counterpart needs or lacks"),
  leverage: z
    .array(z.string())
    .describe("concrete mutual-leverage proposals pairing their assets/needs with ours, actionable, under 20 words each"),
  give: z.array(z.string()).describe("what our side offered"),
  get: z.array(z.string()).describe("what their side offered"),
});

function transcriptText(segments: TranscriptSegment[]): string {
  const lines = segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${s.source === "me" ? "我" : "對方"}: ${s.text}`);
  // Cap the prompt; the tail of the meeting matters most for current state.
  const joined = lines.join("\n");
  return joined.length > 24_000 ? joined.slice(-24_000) : joined;
}

const SYSTEM =
  "You are a realtime meeting-intelligence extractor for the user (speaker 我). " +
  "Read the transcript and return ONLY facts grounded in what was actually said — no speculation. " +
  "Empty arrays/strings are correct when nothing qualifies. Answer values in the transcript's language.";

/**
 * Run one extraction for `type` and publish the result into the store. No-op
 * for "general" (the board shows goals only), when a run is in flight, or when
 * there's nothing to read yet.
 */
export async function runIntelExtraction(type: MeetingType): Promise<void> {
  const state = useStore.getState();
  if (type === "general" || state.intelStatus === "running") return;
  if (!hasProviderKey(state.settings)) return;
  const transcript = transcriptText(state.segments);
  if (transcript.length < 40) return;

  state.setIntelStatus("running");
  try {
    let intel: IntelState;
    if (type === "negotiation") {
      const { object } = await generateObjectResilient({
        settings: state.settings,
        kind: "eval",
        schema: negotiationSchema,
        system: SYSTEM,
        prompt: `Extract the CURRENT negotiation state from this meeting transcript:\n\n${transcript}`,
      });
      intel = { meetingType: type, ...object };
    } else if (type === "sales") {
      const { object } = await generateObjectResilient({
        settings: state.settings,
        kind: "eval",
        schema: salesSchema,
        system: SYSTEM,
        prompt: `Extract the CURRENT sales-call state (BANT signals, objections, commitments) from this transcript:\n\n${transcript}`,
      });
      intel = { meetingType: type, ...object };
    } else {
      const { object } = await generateObjectResilient({
        settings: state.settings,
        kind: "eval",
        schema: partnershipSchema,
        system: SYSTEM,
        prompt:
          "Extract the CURRENT partnership-talk state from this transcript. " +
          "For `leverage`, propose concrete ways the two sides can leverage each other " +
          "based on the counterpart's stated position (their assets × our needs, and vice versa), " +
          `including proactive ways WE can help THEM first:\n\n${transcript}`,
      });
      intel = { meetingType: type, ...object };
    }
    useStore.getState().setIntel(intel);
    useStore.getState().setIntelStatus("done");
  } catch (e) {
    log.warn("intel: extraction failed", { type, error: String(e) });
    useStore.getState().setIntelStatus("error");
  }
}
