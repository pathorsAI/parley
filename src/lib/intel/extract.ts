import { z } from "zod";
import { useStore, isTrimmed, type ReplayTrim } from "../store";
import { hasProviderKey } from "../ai/settings";
import { outputLanguageInstruction } from "../ai/profile";
import { generateObjectResilient } from "../ai/generate";
import { resolveBoard, type MeetingBoard } from "./boards";
import { makeRunGuard } from "../analysis/runGuard";
import { log } from "../log";
import type {
  IntelSlotFill,
  IntelState,
  LlmWorkload,
  MeetingType,
  TodoItem,
  TranscriptSegment,
} from "../types";

/**
 * Intelligence-board extraction — THE one transcript→board LLM pass (C
 * integration). Every typed meeting resolves to a slot board (boards.ts); one
 * schema fills its slots, picks the focus, tracks sales objections, and checks
 * the todo list — replacing the per-type schemas and the separate checkTodos
 * loop. Always recomputed from the full transcript, so it self-corrects as
 * context grows — no incremental-merge bugs.
 */

/** Live gap-board fills (§4.3): UI transient — never written to the claim base
 *  directly; the post-meeting review turns them into claim candidates (B6). */
const slotFillsSchema = z
  .array(
    z.object({
      slotId: z.string().describe("id from the provided slot list"),
      text: z.string().describe("the captured intel, ONE sentence, transcript language"),
      quote: z.string().describe("short verbatim quote backing it, else empty"),
      speaker: z.enum(["me", "them"]).describe("who said it"),
    })
  )
  .describe(
    "intel said SO FAR mapped onto the board slots; one fact per entry, a slot can receive " +
      "several entries; empty when nothing qualifies"
  );

/** Keep only fills pointing at slots we actually offered. Exported for tests. */
export function normalizeSlotFills(
  fills: IntelSlotFill[] | undefined,
  knownSlotIds: Set<string>
): IntelSlotFill[] {
  return (fills ?? []).filter((f) => f.text.trim() && knownSlotIds.has(f.slotId));
}

/** Auto-focus (S22): the ONE thing to say next — counter a live challenge, or
 *  chase the next board slot. The board surfaces only this. */
const focusSchema = z.object({
  kind: z
    .enum(["gap", "objection"])
    .describe(
      '"objection" when the counterpart has a fresh UNADDRESSED challenge/doubt on the table ' +
        '(countering it beats gap-chasing); otherwise "gap"'
    ),
  slotId: z
    .string()
    .describe('for "gap": id of the ONE slot to pursue, from the provided list; empty for "objection"'),
  question: z
    .string()
    .describe(
      "ONE speakable line — for gap: a question chasing that slot; for objection: how to answer " +
        "the challenge (may pair evidence with a question back). Ride the counterpart's actual " +
        "words, one ask, never survey-like; transcript language"
    ),
  reason: z.string().describe("why this now, under 8 words, transcript language"),
});

/** Drop a focus that points nowhere or says nothing. Exported for tests. */
export function normalizeFocus(
  focus: { kind: "gap" | "objection"; slotId: string; question: string; reason: string } | undefined,
  knownSlotIds: Set<string>
): IntelState["focusSlot"] {
  if (!focus?.question.trim()) return undefined;
  if (focus.kind === "objection") return { ...focus, slotId: "" };
  return knownSlotIds.has(focus.slotId) ? focus : undefined;
}

const objectionsSchema = z
  .array(
    z.object({
      text: z.string().describe("the objection, under 15 words"),
      addressed: z.boolean().describe("was it substantively answered"),
    })
  )
  .describe("challenges/doubts the counterpart raised; empty when none");

const todoChecksSchema = z
  .array(z.string())
  .describe(
    "ids of checklist items that have CLEARLY been addressed/covered in the conversation; " +
      "be conservative; empty when no checklist was given or nothing qualifies"
  );

/** ONE schema for every scenario (scenario system): board fills + focus +
 *  objection ledger + todo checks. */
const boardSchema = z.object({
  slotFills: slotFillsSchema,
  focus: focusSchema,
  objections: objectionsSchema,
  todoChecks: todoChecksSchema,
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

/** Below this much spoken text an extraction has nothing to work with. */
const MIN_TRANSCRIPT_CHARS = 40;

/**
 * Enough final (untrimmed) speech for an extraction? THE shared predicate
 * between this runner and the study pipeline's scheduler — if they disagreed,
 * the pipeline would keep offering an extraction the runner silently declines
 * and the chip would show "queued" forever. Cheap early-exit sum.
 */
export function intelTranscriptReady(
  segments: TranscriptSegment[],
  trim: ReplayTrim | null = null
): boolean {
  let total = 0;
  for (const s of segments) {
    if (!s.isFinal || isTrimmed(s, trim)) continue;
    total += s.text.trim().length;
    if (total >= MIN_TRANSCRIPT_CHARS) return true;
  }
  return false;
}

// Output rides the app's configured language (outputLanguageInstruction, appended
// per run below) so the intel board matches the brief/action items on the report
// page. The SPEAKABLE fields (slotFills.text, focus.question/reason) opt back
// into the transcript's language via their own descriptions — a line the user
// will say out loud must be in the meeting's language.
const SYSTEM =
  "You are a realtime meeting-intelligence extractor for the user (speaker 我). " +
  "Read the transcript and return ONLY facts grounded in what was actually said — no speculation. " +
  "Empty arrays/strings are correct when nothing qualifies.";

function buildPrompt(opts: {
  board: MeetingBoard;
  transcript: string;
  openTodos: TodoItem[];
}): string {
  const { board, transcript, openTodos } = opts;
  const slotLines = board.slots.map((s) => `- ${s.id}: ${s.label} — ${s.hint}`).join("\n");
  const todoLines = openTodos.map((t) => `- [${t.id}] ${t.text}`).join("\n");
  return (
    `${board.guidance}\n\n` +
    `Fill slotFills: map intel that was actually said onto these board slots (ONLY these ids; ` +
    `a slot can receive several items). The slots are listed in their intended question ORDER:\n` +
    `${slotLines}\n\n` +
    `Then set focus — the ONE thing to say next. Conversations aren't linear: if the counterpart ` +
    `has a fresh challenge/doubt still unaddressed, focus on COUNTERING it (kind "objection"). ` +
    `Otherwise chase a gap (kind "gap"): the earliest slot in order still unfilled or thin, ` +
    `UNLESS the conversation is actively on a later slot's ground (then take it); if the topic ` +
    `drifted away from an unfinished earlier slot, steer back. Either way the line must ride ` +
    `what the counterpart just said.\n\n` +
    (todoLines
      ? `Checklist to auto-check (return covered ids in todoChecks):\n${todoLines}\n\n`
      : "") +
    transcript
  );
}

/**
 * Run one extraction for `type` and publish the result into the store. No-op
 * for "general" (the board shows goals only), when a run is in flight, or when
 * there's nothing to read yet. `workload` picks the lane: "realtime" for the
 * live board's periodic refresh, "deep" for replay/study passes (#131). A run
 * that outlives its session or is superseded stops writing (see runGuard); a
 * REPLAY run landing after the user switched to a different template discards
 * its result and resets to "idle" so the pipeline extracts the new type.
 */
const guard = makeRunGuard();
export async function runIntelExtraction(
  type: MeetingType,
  workload: LlmWorkload = "realtime"
): Promise<void> {
  const state = useStore.getState();
  if (type === "general" || state.intelStatus === "running") return;
  if (!hasProviderKey(state.settings, workload)) return;
  // REPLAY honors the trim keep-window, same as every other study pass.
  const trim = state.appMode === "replay" ? state.replayTrim : null;
  const segments = trim ? state.segments.filter((s) => !isTrimmed(s, trim)) : state.segments;
  if (!intelTranscriptReady(segments)) return;
  const transcript = transcriptText(segments, CAP_CHARS[workload]);

  // The todo auto-check rides this same pass (one LLM loop per typed meeting);
  // it's a LIVE concern — replay/study extractions never see the checklist.
  const openTodos = workload === "realtime" ? state.todos.filter((t) => !t.done) : [];

  const alive = guard.begin();
  // Did the user switch templates while this run was in flight? Its result
  // belongs to the OLD type: discard it and hand the status back to "idle" so
  // the pipeline dispatches the currently-picked type.
  const staleType = () =>
    useStore.getState().appMode === "replay" && useStore.getState().studyMeetingType !== type;

  state.setIntelStatus("running");
  try {
    const board = await resolveBoard(type, state.settings);
    if (!board) {
      // The scenario no longer exists (a deleted custom id on an old recording
      // or stale settings). Degrade the pick to "general" so the study
      // pipeline stops re-dispatching this extraction forever, and never
      // leave "running" stuck.
      log.warn("intel: unknown scenario — degrading to general", { type });
      const s = useStore.getState();
      if (s.appMode === "replay" && s.studyMeetingType === type) s.setStudyMeetingType("general");
      s.setIntelStatus("idle");
      return;
    }
    const prompt = buildPrompt({ board, transcript, openTodos });
    const system = SYSTEM + outputLanguageInstruction(state.settings);
    const { object } = await generateObjectResilient({
      settings: state.settings,
      workload,
      schema: boardSchema,
      system,
      prompt,
    });

    const known = new Set(board.slots.map((s) => s.id));
    const intel: IntelState = {
      meetingType: type,
      slotFills: normalizeSlotFills(object.slotFills, known),
      focusSlot: normalizeFocus(object.focus, known),
      objections: object.objections,
    };
    if (!alive()) return;
    // Todo checks are transcript-grounded — valid even when the intel result
    // itself is stale-typed; only a dead session discards them.
    const openIds = new Set(openTodos.map((t) => t.id));
    const done = object.todoChecks.filter((id) => openIds.has(id));
    if (done.length) useStore.getState().markTodosDone(done);
    if (staleType()) {
      useStore.getState().setIntelStatus("idle");
      return;
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
    if (!alive()) return;
    // A stale-type failure must not block the newly picked type behind "error".
    useStore.getState().setIntelStatus(staleType() ? "idle" : "error");
  }
}
