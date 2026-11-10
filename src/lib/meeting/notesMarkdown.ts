// The in-meeting notes are stored as a Markdown string (`meetingNotes`). The
// floating window edits them in a rich-text editor (Tiptap) and the study page
// renders them with react-markdown. These helpers are the pure edges of that:
// what the editor's output is normalised to, how many "notes" a text holds, and
// how older plain-text notes are made to keep their line breaks when rendered.

/**
 * The editor's serialised Markdown, as stored: trailing whitespace dropped, and
 * a document with no text at all is "" — `contextWithNotes` checks
 * `notes.trim()`, and an empty pad must not save a stray newline.
 */
export function normalizeNotesMarkdown(markdown: string): string {
  return markdown.trim() ? markdown.trimEnd() : "";
}

/** A line that carries no words of its own: list or task markers, a quote
 *  marker, a heading hash, a code fence or a rule. */
const SYNTAX_ONLY = /^\s*(?:(?:[-*+]|\d+[.)])\s*(?:\[[ xX]?\]\s*)?|>+\s*|#{1,6}\s*|`{3,}.*|~{3,}.*|(?:[-*_]\s*){3,})$/;

/**
 * How many notes a text holds: one per line that has words on it. A list of
 * three items is three notes; blank lines and lines that are only Markdown
 * syntax (an empty bullet, a code fence) count for nothing.
 */
export function notesLineCount(notes: string): number {
  if (!notes) return 0;
  return notes.split("\n").filter((line) => line.trim() && !SYNTAX_ONLY.test(line)).length;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Notes made ready for a Markdown renderer. Notes typed before the rich-text
 * editor were plain text, one thought per line; Markdown would join those lines
 * into one paragraph. Every single line break outside a code fence becomes a
 * hard break (two trailing spaces) so they stay lines. Harmless for the
 * editor's own output: list items, headings and blank-line-separated paragraphs
 * render the same with or without trailing spaces.
 */
export function notesForDisplay(notes: string): string {
  const lines = notes.split("\n");
  let fenced = false;
  return lines
    .map((line, i) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || !line.trim()) return line;
      const next = lines[i + 1];
      // Only a line followed by another line of text needs the break.
      if (next === undefined || !next.trim() || line.endsWith("  ")) return line;
      return `${line.trimEnd()}  `;
    })
    .join("\n");
}
