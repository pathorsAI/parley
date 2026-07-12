import { z } from "zod";
import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateObjectResilient } from "../ai/generate";
import { resolveMeetingBundle } from "../accounts/currentStage";
import { log } from "../log";
import type {
  IntelSlotFill,
  IntelState,
  LlmWorkload,
  MeetingType,
  TranscriptSegment,
} from "../types";

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

/** Live gap-board fills (§4.3): UI transient — never written to the claim base. */
const slotFillsSchema = z
  .array(
    z.object({
      slotId: z.string().describe("id from the provided slot list"),
      text: z.string().describe("the captured intel, ONE sentence, transcript language"),
      quote: z.string().describe("short verbatim quote backing it, else empty"),
      speaker: z.enum(["me", "them"]).describe("who said it"),
    })
  )
  .describe("intel said SO FAR that fills the gap-board slots; empty when nothing qualifies");

/** Keep only fills pointing at slots we actually offered. Exported for tests. */
export function normalizeSlotFills(
  fills: IntelSlotFill[] | undefined,
  knownSlotIds: Set<string>
): IntelSlotFill[] {
  return (fills ?? []).filter((f) => f.text.trim() && knownSlotIds.has(f.slotId));
}

/** Auto-focus (S22): ONE slot to chase next — the board highlights only this. */
const focusSchema = z.object({
  slotId: z.string().describe("id of the ONE slot to pursue next, from the provided list"),
  question: z
    .string()
    .describe(
      "ONE speakable question chasing that slot — ride the counterpart's actual words, " +
        "open-ended, one ask, never survey-like; transcript language"
    ),
  reason: z.string().describe("why this slot now, under 8 words, transcript language"),
});

/** Drop a focus that points nowhere or says nothing. Exported for tests. */
export function normalizeFocus(
  focus: { slotId: string; question: string; reason: string } | undefined,
  knownSlotIds: Set<string>
): IntelState["focusSlot"] {
  if (!focus || !focus.question.trim() || !knownSlotIds.has(focus.slotId)) return undefined;
  return focus;
}

const partnershipSchema = z.object({
  theyHave: z.array(z.string()).describe("assets/strengths the counterpart has (channels, users, tech, team)"),
  theyNeed: z.array(z.string()).describe("things the counterpart needs or lacks"),
  leverage: z
    .array(z.string())
    .describe("concrete mutual-leverage proposals pairing their assets/needs with ours, actionable, under 20 words each"),
  give: z.array(z.string()).describe("what our side offered"),
  get: z.array(z.string()).describe("what their side offered"),
});

function transcriptText(segments: TranscriptSegment[], capChars: number): string {
  const lines = segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${s.source === "me" ? "我" : "對方"}: ${s.text}`);
  // Cap the prompt; the tail of the meeting matters most for current state.
  const joined = lines.join("\n");
  return joined.length > capChars ? joined.slice(-capChars) : joined;
}

/** Live refreshes read a short tail (fast, cheap, current); replay/study passes
 *  read the long window for accuracy. */
const CAP_CHARS: Record<LlmWorkload, number> = { realtime: 8_000, deep: 24_000 };

const SYSTEM =
  "You are a realtime meeting-intelligence extractor for the user (speaker 我). " +
  "Read the transcript and return ONLY facts grounded in what was actually said — no speculation. " +
  "Empty arrays/strings are correct when nothing qualifies. Answer values in the transcript's language.";

/**
 * Run one extraction for `type` and publish the result into the store. No-op
 * for "general" (the board shows goals only), when a run is in flight, or when
 * there's nothing to read yet. `workload` picks the lane: "realtime" for the
 * live board's periodic refresh, "deep" for replay/study passes (#131).
 */
export async function runIntelExtraction(
  type: MeetingType,
  workload: LlmWorkload = "realtime"
): Promise<void> {
  const state = useStore.getState();
  if (type === "general" || state.intelStatus === "running") return;
  if (!hasProviderKey(state.settings, workload)) return;
  const transcript = transcriptText(state.segments, CAP_CHARS[workload]);
  if (transcript.length < 40) return;

  state.setIntelStatus("running");
  try {
    let intel: IntelState;
    if (type === "negotiation") {
      const { object } = await generateObjectResilient({
        settings: state.settings,
        workload,
        schema: negotiationSchema,
        system: SYSTEM,
        prompt: `Extract the CURRENT negotiation state from this meeting transcript:\n\n${transcript}`,
      });
      intel = { meetingType: type, ...object };
    } else if (type === "sales") {
      // THIS call's stage bundle drives the gap-board fills (S19/§4.3).
      const bundle = await resolveMeetingBundle(state.settings);
      const slotLines = bundle.slots.map((s) => `- ${s.id}: ${s.label} — ${s.hint}`).join("\n");
      const { object } = await generateObjectResilient({
        settings: state.settings,
        workload,
        schema: salesSchema.extend({ slotFills: slotFillsSchema, focus: focusSchema }),
        system: SYSTEM,
        prompt:
          `Extract the CURRENT sales-call state (BANT signals, objections, commitments) from this transcript.\n\n` +
          `Additionally fill slotFills: map intel that was actually said onto these gap-board slots ` +
          `(ONLY these ids; a slot can receive several items). The slots are listed in the stage's ` +
          `intended question ORDER:\n${slotLines}\n\n` +
          `Then set focus — the ONE slot the salesperson should chase next: the earliest slot in ` +
          `order that is still unfilled or thin, UNLESS the conversation is actively on a later ` +
          `slot's ground (then take it); if the topic drifted away from an unfinished earlier slot, ` +
          `steer back to it. Craft the question so it rides what the counterpart just said.\n\n${transcript}`,
      });
      const known = new Set(bundle.slots.map((s) => s.id));
      intel = {
        meetingType: type,
        ...object,
        slotFills: normalizeSlotFills(object.slotFills, known),
        focusSlot: normalizeFocus(object.focus, known),
      };
    } else {
      const { object } = await generateObjectResilient({
        settings: state.settings,
        workload,
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
    // Save the result onto the loaded entry (no-op live / unsaved) so reopening
    // the recording never re-spends this extraction.
    void import("../history/history").then((m) =>
      m.persistStudyOutputs().catch((e) =>
        log.warn("intel: persist failed", { error: String(e) })
      )
    );
  } catch (e) {
    log.warn("intel: extraction failed", { type, error: String(e) });
    useStore.getState().setIntelStatus("error");
  }
}
