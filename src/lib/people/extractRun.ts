// After a recording is saved: read it once for small-talk candidates about the
// other people in it (ai/peopleNotes.ts) and file them, as candidates, in the
// people document. One recording at a time, each read at most once — a
// recording that yields nothing is remembered too, so it is not paid for
// again. Runs in the main window; never blocks a save.

import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";
import { hasSpokenSegment } from "../replay/keepWindow";
import { isSampleEntry } from "../onboarding/sample";
import { extractPeopleNotes } from "../ai/peopleNotes";
import { log } from "../log";
import { loadPeople, mutatePeople } from "./store";
import { withExtracted, withNote } from "./notes";

let chain: Promise<unknown> = Promise.resolve();

/** Queue the pass for a saved recording. Never throws, never blocks. */
export function queuePeopleNotes(entryId: string): void {
  if (!entryId) return;
  chain = chain
    .then(() => runPeopleNotesForEntry(entryId))
    .catch((error) => log.warn("people: extraction failed", { entryId, error: String(error) }));
}

/** Resolves once everything queued has run (for tests). */
export function peopleNotesSettled(): Promise<unknown> {
  return chain;
}

/**
 * Read one saved recording for candidates. Skipped without a realtime model,
 * with auto-analysis off (those recordings are left for an external AI), for
 * the bundled sample, and for a recording already read. Resolves to how many
 * candidates were filed, or null when it did not run.
 */
export async function runPeopleNotesForEntry(entryId: string): Promise<number | null> {
  const { settings } = useStore.getState();
  if (!hasProviderKey(settings, "realtime") || !settings.autoStudyAnalysis || isSampleEntry({ id: entryId })) return null;
  if ((await loadPeople()).extracted.includes(entryId)) return null;

  const { entryWritesSettled, readEntry } = await import("../history/entryStore");
  await entryWritesSettled(entryId);
  const entry = (await readEntry(entryId)).meta;
  if (!hasSpokenSegment(entry.segments ?? [])) return null;

  const names = entry.speakerNames ?? {};
  const selfName = entry.selfSpeaker ? names[entry.selfSpeaker] : undefined;
  const found = await extractPeopleNotes({
    settings,
    segments: entry.segments,
    names,
    meetingContext: entry.meetingContext ?? "",
    selfNames: [settings.userName, selfName ?? ""],
  });
  // A failed pass is not marked as read, so it can be run again.
  if (found === null) return null;

  const now = Date.now();
  await mutatePeople((doc) => {
    let next = withExtracted(doc, entryId);
    for (const n of found) {
      next = withNote(
        next,
        { name: n.name, org: n.org, text: n.text, quote: n.quote, atMs: n.atMs, saidAt: entry.createdAt, recordingId: entryId, status: "candidate" },
        now,
      ).doc;
    }
    return next;
  });
  log.info("people: candidates filed", { entryId, count: found.length });
  return found.length;
}
