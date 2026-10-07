import { useStore, isTrimmed, hasSpokenSegment } from "../store";
import { hasProviderKey } from "../ai/settings";
import { suggestFiling } from "../ai/filing";
import { filingChoices, listLocalFolders } from "../history/folders";
import { landStage, makeRunGuard } from "./runGuard";
import { log } from "../log";

/**
 * Propose a better title for the loaded recording plus the folders it could be
 * filed under, into the store and onto the loaded entry. The ONE entry point for
 * both the study pipeline (which dispatches it as soon as there is a transcript
 * — it depends on nothing upstream) and the card's manual regenerate (`force`
 * re-runs over a done/error state; the pipeline never forces). A run that
 * outlives its recording being on screen still saves its suggestion onto that
 * entry; a superseded run is discarded (runGuard).
 *
 * Unlike the report artifacts this rides the cheap REALTIME lane, so a user who
 * only configured that provider still gets the suggestion.
 *
 * ONCE per recording, across devices: a recording whose entry says the pass
 * already ran (`filingSuggested`, or a suggestion still pending — including one a
 * phone wrote and the cloud brought down) restores with filingStatus "done"
 * (store.restoredStudyStatuses), and this runner declines anything not "idle".
 * A second pass would only produce a second, different title for the same
 * recording.
 */
const guard = makeRunGuard("filing");

/** Cancel the filing pass running for the recording on screen. */
export function cancelFilingSuggestion(): boolean {
  return guard.cancel();
}

// Recordings whose pass came back empty this session (replay and entry ids).
// Not persisted (see the landing below), so reopening one restores "idle" — and
// without this the same device would pay for the same empty answer on every
// open. Process-lifetime only: a restart, or another device, tries again.
const emptyThisSession = new Set<string>();
function rememberEmpty(...ids: (string | null | undefined)[]): void {
  for (const id of ids) if (id) emptyThisSession.add(id);
}

/** Whether a non-forced run should not start at all. Returns true after marking
 *  the stage done when this session already got an empty answer for it. */
function alreadyAnswered(state: ReturnType<typeof useStore.getState>): boolean {
  if (state.filingStatus !== "idle") return true;
  const key = state.loadedHistoryId ?? state.replay?.id;
  if (key && emptyThisSession.has(key)) {
    state.setFilingStatus("done");
    return true;
  }
  // Belt and braces for the once-per-recording rule above: a pending suggestion
  // on screen means the pass already ran, whatever the status says.
  return state.filingSuggestion != null;
}

export async function runFilingSuggestion(opts?: { force?: boolean }): Promise<void> {
  const state = useStore.getState();
  if (state.filingStatus === "running") return;
  if (!opts?.force && alreadyAnswered(state)) return;
  if (!hasProviderKey(state.settings, "realtime")) return;
  // A read-only org recording can be neither renamed nor refiled, so a suggestion
  // for it would be pure spend on something the user cannot act on.
  if (state.replayReadOnly) return;
  // Honor the trim keep-window, same as the analysis + brief passes.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (!hasSpokenSegment(segments)) return;

  const run = guard.begin();
  state.setFilingStatus("running");
  try {
    const currentTitle = state.replay?.name ?? "";
    let suggestion = await suggestFiling({
      settings: state.settings,
      segments,
      names: state.speakerNames,
      // The plain per-meeting context only — not the desktop-only negotiation
      // setup meetingBriefText folds in, since the phones have no such fields
      // and the model must see the same inputs on every platform.
      meetingContext: state.meetingContext,
      // Never propose an archived folder: the user put it away, and a suggestion
      // to file today's call into it would undo that decision for them.
      folders: filingChoices(listLocalFolders()).map((f) => ({ id: f.id, name: f.name })),
      currentTitle,
      signal: run.signal,
    });
    // Renamed while the pass ran: the user has named it, which answers the title
    // half (the same rule renameHistoryEntry applies to a pending suggestion).
    // Only checkable while the recording is still on screen; the folders stand.
    const now = useStore.getState();
    if (
      suggestion?.title &&
      run.alive() &&
      (now.replay?.name ?? "") !== currentTitle
    ) {
      suggestion = suggestion.folders.length > 0 ? { ...suggestion, title: "" } : null;
    }
    // A null suggestion — nothing usable (the title failed the gates and no
    // folder survived) or a failed call — is done for THIS session only: the
    // stage reads "done" so the scheduler leaves it alone, but nothing is
    // persisted. Writing filingSuggested: true would sync to the cloud and stop
    // every other device from trying, over a result that offered nothing; the
    // same rule holds on iOS and Android. A usable suggestion IS persisted with
    // the flag, so the recording never pays for the pass a second time
    // (HistoryEntry.filingSuggested).
    // A cancelled pass also comes back null (suggestFiling swallows the abort),
    // but it was never answered — remembering it would make the restart that
    // cancelled it decline to run.
    if (!suggestion && !run.superseded()) rememberEmpty(state.replay?.id, run.target().entryId);
    await landStage(run, {
      stage: "filing",
      apply: () => {
        useStore.getState().setFilingSuggestion(suggestion);
        useStore.getState().setFilingStatus("done");
      },
      patch: suggestion ? { filingSuggestion: suggestion, filingSuggested: true } : null,
      persistWhileLoaded: true,
    });
  } catch (e) {
    if (run.superseded()) log.info("filing: superseded pass ended", { error: String(e) });
    else log.error("filing: suggestion failed", { error: String(e) });
    await landStage(run, {
      stage: "filing",
      error: String(e),
      apply: () => useStore.getState().setFilingStatus("error"),
      patch: null,
    });
  } finally {
    run.end();
  }
}
