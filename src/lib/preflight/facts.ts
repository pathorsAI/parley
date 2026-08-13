import type { SlotDef } from "../accounts/bundleFile";
import type { SlotState } from "../accounts/slotState";
import type { Claim, ClaimCategory, Company, Person, Thread } from "../accounts/types";

/**
 * Everything the pre-flight copilot knows before a word is spoken, assembled
 * from the claim base rather than asked of the user.
 *
 * Deliberately pure and LLM-free: the same structure drives the deterministic
 * opening line (which must render instantly, offline, with no API key) AND the
 * prompt digest. One source means the number in the headline can never disagree
 * with the number the model was told.
 */

export interface PrepGap {
  id: string;
  label: string;
  state: SlotState;
  /** Freshest card sitting in the slot, if any — what we already believe. */
  top: string | null;
}

export interface PrepAttendee {
  name: string;
  title: string;
  role: string | null;
  stance: "support" | "neutral" | "oppose" | null;
}

export interface PrepFacts {
  company: { name: string; note: string };
  thread: { name: string; kind: string } | null;
  stageLabel: string | null;
  attendees: PrepAttendee[];
  /** Most recent first. */
  meetings: { title: string; at: number }[];
  redlines: string[];
  openQuestions: string[];
  gaps: PrepGap[];
  leverageOurs: string[];
  leverageTheirs: string[];
  risks: string[];
  competitors: string[];
  nextMoves: string[];
  /** What the user has already put down for THIS call. */
  prep: { target: string; batna: string; floor: string; context: string; agenda: string[] };
}

/** Freshest-first, capped — a prompt full of stale duplicates helps nobody. */
function texts(claims: Claim[], category: ClaimCategory, n: number, side?: "ours" | "theirs"): string[] {
  return claims
    .filter((c) => c.category === category && (side ? c.side === side : true))
    .sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)
    .slice(0, n)
    .map((c) => c.text);
}

export function collectPrepFacts(opts: {
  company: Company;
  thread: Thread | null;
  attendees: Person[];
  /** Active claims already scoped to this company + linked thread. */
  claims: Claim[];
  /** The gap board this meeting will actually open with. */
  boardRows: { slot: SlotDef; claims: Claim[]; state: SlotState }[];
  stageLabel: string | null;
  meetings: { title: string; createdAt: number }[];
  prep: { target: string; batna: string; floor: string; context: string; agenda: string[] };
  roleLabel: (role: string) => string;
}): PrepFacts {
  const { company, thread, attendees, claims, boardRows, stageLabel, meetings, prep } = opts;

  return {
    company: { name: company.name, note: company.note },
    thread: thread ? { name: thread.name, kind: thread.kind } : null,
    stageLabel,
    attendees: attendees.map((p) => ({
      name: p.name,
      title: p.title,
      role: p.committeeRole ? opts.roleLabel(p.committeeRole) : null,
      stance: p.stance?.value ?? null,
    })),
    meetings: meetings
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((m) => ({ title: m.title, at: m.createdAt })),
    redlines: texts(claims, "redline", 6),
    openQuestions: texts(claims, "openq", 8),
    gaps: boardRows.map(({ slot, claims: cards, state }) => ({
      id: slot.id,
      label: slot.label,
      state,
      top: [...cards].sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)[0]?.text ?? null,
    })),
    leverageOurs: texts(claims, "leverage", 4, "ours"),
    leverageTheirs: texts(claims, "leverage", 4, "theirs"),
    risks: texts(claims, "risk", 4),
    competitors: texts(claims, "competitor", 4),
    nextMoves: texts(claims, "nextmove", 4),
    prep,
  };
}

/** The numbers the opening line reports. Derived, never stored. */
export interface PrepHeadline {
  /** Nth conversation with this company — the one we're about to have. */
  nth: number;
  lastMeeting: { title: string; at: number } | null;
  redlines: number;
  openQuestions: number;
  emptyGaps: string[];
  thinGaps: string[];
}

export function prepHeadline(facts: PrepFacts): PrepHeadline {
  return {
    nth: facts.meetings.length + 1,
    lastMeeting: facts.meetings[0] ?? null,
    redlines: facts.redlines.length,
    openQuestions: facts.openQuestions.length,
    emptyGaps: facts.gaps.filter((g) => g.state === "empty").map((g) => g.label),
    thinGaps: facts.gaps.filter((g) => g.state === "thin").map((g) => g.label),
  };
}

const GAP_MARK: Record<SlotState, string> = { solid: "✔", thin: "△", empty: "○" };

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
  const note = facts.company.note ? ` — ${facts.company.note}` : "";
  const head: string[] = [`Company: ${facts.company.name}${note}`];
  if (facts.thread) head.push(`Thread (戰線): ${facts.thread.name} (${facts.thread.kind})`);
  if (facts.stageLabel) head.push(`Stage: ${facts.stageLabel}`);
  head.push(`This will be conversation #${facts.meetings.length + 1} with them.`);

  const people = facts.attendees.map((a) => {
    const bits = [a.title, a.role, a.stance].filter(Boolean);
    const detail = bits.length ? `（${bits.join("・")}）` : "";
    return `${a.name}${detail}`;
  });

  const past = facts.meetings
    .slice(0, 5)
    .map((m) => `${new Date(m.at).toISOString().slice(0, 10)} ${m.title}`);

  const gaps = facts.gaps.map((g) => {
    const filling = g.top ? `: ${g.top}` : ": (nothing yet)";
    return `${GAP_MARK[g.state]} ${g.label}${filling}`;
  });

  const prep: string[] = [
    `Goal for this call: ${facts.prep.target || "(not set yet)"}`,
    `My BATNA: ${facts.prep.batna || "(not set yet)"}`,
    `My bottom line: ${facts.prep.floor || "(not set yet)"}`,
    `Agenda items so far: ${facts.prep.agenda.length ? facts.prep.agenda.join(" / ") : "(none)"}`,
  ];

  return (
    `${head.join("\n")}\n\n` +
    block("Attendees", people) +
    block("Past meetings (newest first)", past) +
    block("Gap board for this stage (✔ solid / △ thin / ○ empty)", gaps) +
    block("⚠️ RED LINES — things I must NOT reveal or cross", facts.redlines) +
    block("Open questions still unanswered", facts.openQuestions) +
    block("Our leverage", facts.leverageOurs) +
    block("Their leverage", facts.leverageTheirs) +
    block("Risks", facts.risks) +
    block("Competitors", facts.competitors) +
    block("Next moves already logged", facts.nextMoves) +
    block("My current prep for this call", prep) +
    (facts.prep.context.trim() ? `Background I pasted in:\n${facts.prep.context.trim()}\n` : "")
  );
}
