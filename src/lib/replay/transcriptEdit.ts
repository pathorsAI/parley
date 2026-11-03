// Editing the loaded recording's transcript text: the replay find bar's
// replace, end to end — store, saved entry, and the dictionary nudge after.

import { useStore } from "../store";
import { translate } from "../../i18n/messages";
import { log } from "../log";
import { addEntry, whenDictionaryReady, type AddResult } from "../dictionary";
import { persistTranscriptText } from "../history/history";
import { replaceInSegments } from "./findReplace";
import type { TranscriptSegment } from "../types";

/**
 * Replace `query` with `replacement` in the loaded recording's transcript —
 * every line, or only `onlySegmentId` — and persist it. Returns how many
 * occurrences changed (0 = nothing happened, nothing written).
 *
 * The store takes the new text at once; the saved entry follows in the
 * background through {@link persistTranscriptText}. A not-yet-saved upload has
 * no entry yet — its first save snapshots the store, edited text included. A
 * read-only org recording is refused outright: the UI never offers replace
 * there, and its text belongs to someone else.
 */
export function replaceInTranscript(
  query: string,
  replacement: string,
  opts: { onlySegmentId?: string } = {},
): number {
  const s = useStore.getState();
  if (!s.replay || s.replayReadOnly) return 0;
  const { segments, count } = replaceInSegments(s.segments, query, replacement, opts);
  if (count === 0) return 0;
  record({ replayId: s.replay.id, before: s.segments, after: segments, from: query, to: replacement });
  apply(segments);
  log.info("replay: transcript text replaced", { count, single: opts.onlySegmentId !== undefined });
  return count;
}

/** Put `segments` in the store and the saved entry. */
function apply(segments: TranscriptSegment[]): void {
  const s = useStore.getState();
  s.applyTranscriptEdit(segments);
  const id = s.loadedHistoryId;
  if (id) {
    persistTranscriptText(id, segments).catch((e) =>
      log.error("replay: transcript edit save failed", { id, error: String(e) }),
    );
  }
}

/** One transcript edit, as the text before and after it, for ⌘Z / ⌘⇧Z. */
interface TranscriptEditStep {
  replayId: string;
  before: TranscriptSegment[];
  after: TranscriptSegment[];
  /** The replace it was, for saying what an undo or redo changed. */
  from: string;
  to: string;
}

/** What an undo or redo changed: the text that was there, and what it reads now. */
export interface TranscriptEditChange {
  from: string;
  to: string;
}

/** How many edits back ⌘Z reaches. */
const UNDO_DEPTH = 50;
const undoStack: TranscriptEditStep[] = [];
const redoStack: TranscriptEditStep[] = [];

function record(step: TranscriptEditStep): void {
  // A new edit forks the history: what was undone can't be redone over it.
  redoStack.length = 0;
  undoStack.push(step);
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

/**
 * Step the loaded recording's transcript back (`undo`) or forward (`redo`)
 * one edit, saving it as any edit is. Returns what changed (an undo of
 * party → parley reads parley → party), or null when there is nothing to step
 * — no edit, a read-only recording, or the history belongs to another
 * recording (opening one starts a fresh history).
 */
function step(from: TranscriptEditStep[], to: TranscriptEditStep[], undo: boolean): TranscriptEditChange | null {
  const s = useStore.getState();
  if (!s.replay || s.replayReadOnly) return null;
  if (from.length > 0 && from[from.length - 1].replayId !== s.replay.id) {
    undoStack.length = 0;
    redoStack.length = 0;
    return null;
  }
  const last = from.pop();
  if (!last) return null;
  to.push(last);
  apply(undo ? last.before : last.after);
  log.info(undo ? "replay: transcript edit undone" : "replay: transcript edit redone");
  return undo ? { from: last.to, to: last.from } : { from: last.from, to: last.to };
}

/** The {from} / {to} of a change's message. Deleting a word replaces it with
 *  nothing, which would read as a dangling arrow, so the empty side is named. */
export function editChangeVars(
  language: Parameters<typeof translate>[0],
  change: TranscriptEditChange,
): { from: string; to: string } {
  const side = (text: string) => text.trim() || translate(language, "replay.emptyText");
  return { from: side(change.from), to: side(change.to) };
}

export const undoTranscriptEdit = (): TranscriptEditChange | null => step(undoStack, redoStack, true);
export const redoTranscriptEdit = (): TranscriptEditChange | null => step(redoStack, undoStack, false);

/** For tests: start from an empty history. */
export function resetTranscriptHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

/**
 * Teach the dictionary the word a replace just fixed: `to` becomes a term,
 * with the misheard `from` as a variant — the same shape the speaker-background
 * correction loop learns (onboarding/micCheck `learnTerm`), so the next
 * transcription is biased toward the right spelling AND rewrites the old one.
 * Already known (same phrase, same variant) → nothing is added, and the result
 * is null.
 */
export async function teachReplacement(from: string, to: string): Promise<AddResult | null> {
  await whenDictionaryReady();
  const variant = from.trim();
  return addEntry({
    phrase: to,
    // A case-only fix takes no variant: the phrase itself biases the spelling,
    // and a variant equal to it but for case would only fight it.
    variants: variant && variant.toLowerCase() !== to.trim().toLowerCase() ? [variant] : [],
    source: "correction",
  });
}
