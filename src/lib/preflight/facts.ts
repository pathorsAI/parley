import type { SlotDef } from "../scenarios/bundleFile";

/**
 * Everything the system knows before a word is spoken, assembled from what the
 * user set up rather than asked of them again.
 *
 * Deliberately pure and LLM-free: the same structure drives the deterministic
 * opening line (which must render instantly, offline, with no API key) AND the
 * prompt digest. One source means the number in the headline can never disagree
 * with the number the model was told.
 */

export interface PrepFacts {
  /** The folder this call files into — one folder, one customer. */
  folder: string | null;
  scenarioName: string | null;
  stageLabel: string | null;
  /** What "done" looks like for the stage, when its bundle says. */
  exitCriteria: string[];
  /** The board this call will open with: what it wants covered. */
  board: { label: string; hint: string }[];
  /** Most recent first. */
  meetings: { title: string; at: number }[];
  /** What the user has already put down for THIS call. */
  prep: { target: string; batna: string; floor: string; context: string; agenda: string[] };
}

export function collectPrepFacts(opts: {
  folder: string | null;
  scenarioName: string | null;
  stageLabel: string | null;
  exitCriteria: string[];
  slots: SlotDef[];
  meetings: { title: string; createdAt: number }[];
  prep: { target: string; batna: string; floor: string; context: string; agenda: string[] };
}): PrepFacts {
  return {
    folder: opts.folder,
    scenarioName: opts.scenarioName,
    stageLabel: opts.stageLabel,
    exitCriteria: opts.exitCriteria,
    board: opts.slots.map((s) => ({ label: s.label, hint: s.hint })),
    meetings: opts.meetings
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((m) => ({ title: m.title, at: m.createdAt })),
    prep: opts.prep,
  };
}

/** The numbers the opening line reports. Derived, never stored. */
export interface PrepHeadline {
  /** Nth conversation in this folder — the one we're about to have. */
  nth: number;
  lastMeeting: { title: string; at: number } | null;
  boardSlots: number;
}

export function prepHeadline(facts: PrepFacts): PrepHeadline {
  return {
    nth: facts.meetings.length + 1,
    lastMeeting: facts.meetings[0] ?? null,
    boardSlots: facts.board.length,
  };
}

function block(title: string, lines: string[]): string {
  if (!lines.length) return "";
  const body = lines.map((l) => `- ${l}`).join("\n");
  return `${title}:\n${body}\n\n`;
}

/**
 * Render the facts as prompt text. Kept next to the structure it renders so a
 * new field can't be added to `PrepFacts` and silently never reach the model.
 */
export function factsDigest(facts: PrepFacts): string {
  const head: string[] = [];
  if (facts.folder) head.push(`Meeting with: ${facts.folder}`);
  if (facts.scenarioName) head.push(`Kind of call: ${facts.scenarioName}`);
  if (facts.stageLabel) head.push(`Stage: ${facts.stageLabel}`);
  if (facts.meetings.length) {
    head.push(`This will be conversation #${facts.meetings.length + 1} with them.`);
  }

  const past = facts.meetings
    .slice(0, 5)
    .map((m) => `${new Date(m.at).toISOString().slice(0, 10)} ${m.title}`);

  const board = facts.board.map((s) => (s.hint && s.hint !== s.label ? `${s.label}: ${s.hint}` : s.label));

  const prep: string[] = [
    `Goal for this call: ${facts.prep.target || "(not set yet)"}`,
    `My BATNA: ${facts.prep.batna || "(not set yet)"}`,
    `My bottom line: ${facts.prep.floor || "(not set yet)"}`,
    `Agenda items so far: ${facts.prep.agenda.length ? facts.prep.agenda.join(" / ") : "(none)"}`,
  ];

  return (
    `${head.join("\n")}\n\n` +
    block("Past meetings (newest first)", past) +
    block("What this stage's board wants covered", board) +
    block("Stage is finished when", facts.exitCriteria) +
    block("My current prep for this call", prep) +
    (facts.prep.context.trim() ? `Background I pasted in:\n${facts.prep.context.trim()}\n` : "")
  );
}
