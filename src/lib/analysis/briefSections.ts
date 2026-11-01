/**
 * The saved brief, cut at its `## ` headings so the study page can show it a
 * section at a time: the 總結 tab gets one sub-tab per section, and the
 * forward-looking section (what to do or open with next) moves to the 後續行動
 * tab, next to the action items it belongs with.
 *
 * Cutting the saved text — rather than asking the model for separate pieces —
 * costs nothing, works on every recording already saved, and never makes a
 * reopened recording regenerate.
 *
 * The model keeps the prompt's English headings (shared/prompts/study.json
 * `brief.sections`) even when it writes the body in Chinese, so the known
 * headings are matched by name and get a translated label; an unknown one keeps
 * its own text.
 */

/** Every heading the brief prompt asks for, by lens. */
export type BriefSectionKey =
  | "highlights"
  | "decisions"
  | "openQuestions"
  | "nextAgenda"
  | "whereLanded"
  | "painObjections"
  | "unknowns"
  | "nextSteps"
  | "outcome"
  | "fellShort"
  | "improve"
  | "keyMoments";

const KEY_BY_HEADING: Record<string, BriefSectionKey> = {
  highlights: "highlights",
  decisions: "decisions",
  "open questions": "openQuestions",
  "suggested next agenda": "nextAgenda",
  "where this landed": "whereLanded",
  "their pain and objections": "painObjections",
  "what we still don't know": "unknowns",
  "next steps": "nextSteps",
  outcome: "outcome",
  "what fell short": "fellShort",
  "how to improve": "improve",
  "key moments": "keyMoments",
};

/** The sections that say what happens next — shown under 後續行動, not 總結. */
const NEXT_KEYS: ReadonlySet<BriefSectionKey> = new Set(["nextAgenda", "nextSteps"]);

export interface BriefSection {
  key: BriefSectionKey | null;
  /** The heading as written, for a section the prompt doesn't name. */
  title: string;
  body: string;
}

export interface SplitBrief {
  /** Text before the first heading (usually none). */
  lead: string;
  /** The sections the 總結 tab shows, in order. */
  sections: BriefSection[];
  /** The forward-looking sections, for the 後續行動 tab. */
  next: BriefSection[];
}

function keyOf(title: string): BriefSectionKey | null {
  const normalized = title.trim().replace(/[:：]$/, "").toLowerCase().replace(/[’']/g, "'");
  return KEY_BY_HEADING[normalized] ?? null;
}

/**
 * Undo a model's habit of bolding its section headings: `**## Highlights**`
 * (or `__## Highlights__`) is neither a heading to markdown nor to the cutter
 * below, so it showed as literal "## Highlights" and the brief came out uncut.
 * Unwraps only lines that are a heading inside the emphasis.
 */
export function normalizeBriefHeadings(markdown: string): string {
  return markdown.replace(/^[ \t]*(\*\*|__)(#{1,6}[ \t]+[^\n]*?)\1[ \t]*$/gm, "$2");
}

/** Cut a brief at its level-two headings. A brief without any comes back as
 *  one untitled lead, to be shown whole. */
export function splitBrief(markdown: string): SplitBrief {
  const sections: BriefSection[] = [];
  const lead: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    sections.push({ key: keyOf(current.title), title: current.title.trim(), body: current.lines.join("\n").trim() });
  };
  for (const line of normalizeBriefHeadings(markdown).split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      close();
      current = { title: heading[1], lines: [] };
    } else if (current) current.lines.push(line);
    else lead.push(line);
  }
  close();
  const kept = sections.filter((s) => s.body);
  return {
    lead: lead.join("\n").trim(),
    sections: kept.filter((s) => !s.key || !NEXT_KEYS.has(s.key)),
    next: kept.filter((s) => !!s.key && NEXT_KEYS.has(s.key)),
  };
}
