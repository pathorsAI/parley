import { z } from "zod";
import { generateObjectResilient } from "./generate";
import { JSON_MODE_INSTRUCTION } from "./provider";
import { outputLanguageInstruction, profileContext } from "./profile";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
import type { Settings } from "../types";
import type { Claim, Company, Person, Thread } from "../accounts/types";

/**
 * Pre-meeting DRAFT (#189): one LLM pass that proposes what the user was
 * previously asked to type from nothing — the meeting's objective, the actions
 * to take, the pushbacks to expect, and the BATNA / walk-away line.
 *
 * Why this exists at all: 目標 / BATNA / 底線 are CONCLUSIONS, not raw material.
 * Asking for them in empty inputs asks the user to have already finished
 * thinking, so in practice the whole column got skipped. Everything needed to
 * draft them is already in the claim base and the stage's gap board — the
 * system remembers more than the user does at 9:55am. So the machine writes
 * the first version and the user corrects it; nothing here is applied until
 * the user clicks a suggestion.
 */

const schema = z.object({
  goals: z
    .array(z.string())
    .describe(
      "EXACTLY 3 candidate objectives for THIS single meeting, one line each. Each must be " +
        "verifiable before the call ends and name a concrete thing to obtain."
    ),
  agenda: z
    .array(z.string())
    .describe(
      "UP TO 5 ordered ACTIONS I take in the meeting (ask X, propose Y, confirm Z). Short imperative lines."
    ),
  objections: z
    .array(z.string())
    .describe(
      "UP TO 3 pushbacks they are likely to raise, each written as `their objection → my counter`."
    ),
  batna: z
    .string()
    .describe("My best alternative if this meeting produces nothing, ONE line. Empty string if the intel gives no basis."),
  floor: z
    .string()
    .describe("The walk-away line for this meeting, ONE line. Empty string if the intel gives no basis."),
});

/** What the model returns, after clamping. */
export interface PrepDraft {
  goals: string[];
  agenda: string[];
  objections: string[];
  batna: string;
  floor: string;
}

/** One gap-board slot as the draft sees it. */
export interface PrepGap {
  label: string;
  hint: string;
  state: "empty" | "thin" | "solid";
}

export interface PrepDraftInput {
  company: Company;
  thread: Thread | null;
  attendees: Person[];
  /** Active claims for this company, already narrowed to the linked thread. */
  claims: Claim[];
  /** Display name of the stage this meeting opens on. */
  stageName: string;
  /** The stage's one-line goal, when its bundle carries one. */
  stageGoal: string;
  /** What "done" looks like for the stage. */
  exitCriteria: string[];
  /** Every slot on the stage's board with its current state. */
  gaps: PrepGap[];
  /** Whatever the user already typed as background — steers the draft. */
  context: string;
}

const SYSTEM =
  "You are a senior sales strategist preparing ME for ONE upcoming meeting. You are writing a " +
  "DRAFT that I will edit in seconds — not a report. Every line must be short enough to read " +
  "while walking into the room.\n\n" +
  "goals: three DIFFERENT candidate objectives, so I can pick the one that matches my real " +
  "intent. Each names something concrete I can walk out holding — 'find out who signs off " +
  "below NT$300k', not 'convey our value'. Prefer objectives that close the board's empty slots " +
  "or satisfy an exit criterion.\n\n" +
  "agenda: what I DO, in order — ask this, propose that, confirm the other. It is NOT a list of " +
  "information to collect; the gap board already tracks that, and duplicating it there has " +
  "burned us before. Skip anything already solid on the board.\n\n" +
  "objections: only pushbacks the intel actually supports — a stated budget worry, a named " +
  "competitor, a stalled approval. Each line is `what they say → how I answer`.\n\n" +
  "batna / floor: infer from the leverage and risk claims. If the intel gives no honest basis, " +
  "return an empty string. A fabricated walk-away number is worse than none.\n\n" +
  "Rules: ground everything in the provided claims — no invented facts, figures, or names; mark " +
  "anything you inferred rather than read with （推測）; treat `redline` claims as things I must " +
  "NOT reveal, so never propose an action that leaks one; stale claims (old lastSupported dates) " +
  "are weak evidence, so prefer verifying them over building on them." +
  JSON_MODE_INSTRUCTION;

function claimLines(claims: Claim[], persons: Person[]): string {
  const nameOf = (id: string) => persons.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  return claims
    .map((c) => {
      const subj = c.subjects.length ? ` @${c.subjects.map(nameOf).join(",")}` : "";
      const side = c.side ? ` side=${c.side}` : "";
      const fresh = new Date(c.lastSupportedAt).toISOString().slice(0, 10);
      return `- [${c.category}${side}] (${c.confidence}, lastSupported ${fresh})${subj} ${c.text}`;
    })
    .join("\n");
}

/**
 * Assemble the user prompt. Pure and exported so a test can assert the board
 * gaps and red lines actually reach the model — the two inputs that make this
 * draft worth more than a generic checklist.
 */
export function buildPrepPrompt(settings: Settings, input: PrepDraftInput): string {
  const { company, thread, attendees, claims, stageName, stageGoal, exitCriteria, gaps, context } =
    input;
  const parts: string[] = [profileContext(settings)];

  parts.push(`Meeting with: ${company.name}${company.note ? ` — ${company.note}` : ""}`);
  if (thread) {
    parts.push(`Thread (戰線): ${thread.name} · kind=${thread.kind} · status=${thread.status}`);
  }
  parts.push(`Stage: ${stageName}${stageGoal ? ` — ${stageGoal}` : ""}`);
  if (exitCriteria.length) {
    parts.push(`Stage is finished when:\n${exitCriteria.map((x) => `- ${x}`).join("\n")}`);
  }

  if (attendees.length) {
    const lines = attendees.map((p) => {
      const bits = [p.title, p.committeeRole, p.stance?.value].filter(Boolean);
      return `- ${p.name}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    });
    parts.push(`Attending from their side:\n${lines.join("\n")}`);
  }

  // The gap board is the sharpest signal we have about what this meeting is
  // FOR, so it goes in whole — solid slots included, to stop the draft
  // proposing work that is already done.
  const open = gaps.filter((g) => g.state !== "solid");
  const solid = gaps.filter((g) => g.state === "solid");
  if (open.length) {
    parts.push(
      `Board gaps to close (empty = nothing known, thin = weak or stale):\n${open
        .map((g) => `- [${g.state}] ${g.label}${g.hint && g.hint !== g.label ? `：${g.hint}` : ""}`)
        .join("\n")}`
    );
  }
  if (solid.length) {
    parts.push(`Already solid — do NOT spend meeting time here:\n${solid.map((g) => `- ${g.label}`).join("\n")}`);
  }

  parts.push(
    claims.length ? `Intel claims:\n${claimLines(claims, attendees)}` : "Intel claims: (none yet)"
  );
  if (context.trim()) parts.push(`My own notes for this meeting:\n${context.trim()}`);

  return parts.filter(Boolean).join("\n\n");
}

/** Trim, drop blanks, de-duplicate, and cap — the model over-produces. */
function clean(list: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

/** Generate the pre-meeting draft. Nothing is written to the store here. */
export async function draftPrep(opts: {
  settings: Settings;
  input: PrepDraftInput;
}): Promise<PrepDraft> {
  const { settings, input } = opts;
  log.info("prep: draft start", {
    company: input.company.name,
    claims: input.claims.length,
    gaps: input.gaps.filter((g) => g.state !== "solid").length,
  });

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "deep",
    schema,
    system: SYSTEM + outputLanguageInstruction(settings),
    prompt: buildPrepPrompt(settings, input),
  });
  void recordLlmUsage(settings, "deep", "prep-draft", usage);

  const draft: PrepDraft = {
    goals: clean(object.goals, 3),
    agenda: clean(object.agenda, 5),
    objections: clean(object.objections, 3),
    batna: (object.batna ?? "").trim(),
    floor: (object.floor ?? "").trim(),
  };
  log.info("prep: draft ok", {
    goals: draft.goals.length,
    agenda: draft.agenda.length,
    objections: draft.objections.length,
  });
  return draft;
}
