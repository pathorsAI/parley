import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { suggestFiling } from "../ai/filing";
import { listLocalFolders } from "../history/folders";
import { makeRunGuard } from "./runGuard";
import { log } from "../log";

/**
 * Propose a better title for the loaded recording plus the folders it could be
 * filed under, into the store and onto the loaded entry. The ONE entry point for
 * both the study pipeline (which dispatches it as soon as there is a transcript
 * — it depends on nothing upstream) and the card's manual regenerate (`force`
 * re-runs over a done/error state; the pipeline never forces). A run that
 * outlives its session or is superseded by a newer pass stops writing (runGuard).
 *
 * Unlike the report artifacts this rides the cheap REALTIME lane, so a user who
 * only configured that provider still gets the suggestion.
 */
const guard = makeRunGuard();
export async function runFilingSuggestion(opts?: { force?: boolean }): Promise<void> {
  const state = useStore.getState();
  if (state.filingStatus === "running") return;
  if (!opts?.force && state.filingStatus !== "idle") return;
  if (!hasProviderKey(state.settings, "realtime")) return;
  // A read-only org recording can be neither renamed nor refiled, so a suggestion
  // for it would be pure spend on something the user cannot act on.
  if (state.replayReadOnly) return;
  // Honor the trim keep-window, same as the analysis + brief passes.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (!hasSpokenSegment(segments)) return;

  const alive = guard.begin();
  state.setFilingStatus("running");
  try {
    const suggestion = await suggestFiling({
      settings: state.settings,
      segments,
      names: state.speakerNames,
      meetingContext: meetingBriefText(state),
      meetingKind: state.meetingKind,
      folders: listLocalFolders().map((f) => ({ id: f.id, name: f.name })),
      currentTitle: state.replay?.name ?? "",
    });
    if (!alive()) return;
    // A null suggestion (the model had nothing better to propose) is still a
    // COMPLETED run: record it as done and persist, so this recording never pays
    // for the pass a second time. See HistoryEntry.filingSuggested.
    useStore.getState().setFilingSuggestion(suggestion);
    useStore.getState().setFilingStatus("done");
    void import("../history/history").then((m) =>
      m.persistFilingSuggestion().catch((e) =>
        log.warn("filing: persist failed", { error: String(e) })
      )
    );
  } catch (e) {
    log.error("filing: suggestion failed", { error: String(e) });
    if (alive()) useStore.getState().setFilingStatus("error");
  }
}
