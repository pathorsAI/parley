/**
 * The one-shot draft (`ai/prepDraft`) returns each likely pushback as a single
 * line, `what they say → how I answer`. The plan card wants the two halves
 * separately, so it can show the trigger and the counter-move on their own
 * lines.
 *
 * A line the model wrote without the arrow is kept, not dropped: a pushback
 * with no scripted answer is still worth walking in knowing about, and silently
 * discarding it would hide a gap in the draft.
 */
export function splitObjection(line: string): { trigger: string; move: string } {
  const at = line.search(/→|->/);
  if (at < 0) return { trigger: line.trim(), move: "" };
  const arrowLength = line[at] === "→" ? 1 : 2;
  return { trigger: line.slice(0, at).trim(), move: line.slice(at + arrowLength).trim() };
}
