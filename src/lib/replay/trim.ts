import { useStore, type ReplayTrim } from "../store";
import { log } from "../log";

/**
 * Trim the loaded recording to `[trim.startMs, trim.endMs]` — instantly.
 *
 * The audio file is left untouched (no re-encode): we only
 *  - drop the transcript / findings / action items outside the window and rebase
 *    the ones we keep onto a fresh 0-based timeline, and
 *  - shift the session's `audioOffsetMs` so the player (and the voice diarizer)
 *    map that 0-based timeline back onto the original audio.
 *
 * That makes Apply effectively free — the already-computed analysis is reused as
 * is (nothing re-runs), which is the whole point: trimming after analysis must be
 * cheap. Re-uploading the original restores the full recording (cached).
 */
export async function trimRecording(trim: ReplayTrim): Promise<void> {
  const { replay } = useStore.getState();
  if (!replay?.audioPath) throw new Error("No recording loaded to trim.");

  const startMs = Math.max(0, Math.round(trim.startMs));
  const endMs = Math.round(trim.endMs);
  if (endMs <= startMs) return;
  log.info("trim: start", { startMs, endMs });

  const inWindow = (ms: number) => ms >= startMs && ms <= endMs;
  const rebase = (ms: number) => Math.max(0, ms - startMs);

  const s = useStore.getState();
  // Keep segments that overlap the window; shift them onto the new 0-based clock.
  const segments = s.segments
    .filter((seg) => seg.endMs >= startMs && seg.startMs <= endMs)
    .map((seg) => ({ ...seg, startMs: rebase(seg.startMs), endMs: rebase(seg.endMs) }));
  const findings = s.findings.filter((f) => inWindow(f.atMs)).map((f) => ({ ...f, atMs: rebase(f.atMs) }));
  const actionItems = s.actionItems
    .filter((a) => a.atMs == null || inWindow(a.atMs))
    .map((a) => ({ ...a, atMs: a.atMs == null ? null : rebase(a.atMs) }));

  // Accumulate the offset so repeated trims compose; the audio file never changes.
  const audioOffsetMs = (replay.audioOffsetMs ?? 0) + startMs;
  const durationMs = endMs - startMs;

  useStore.setState({
    replay: { ...replay, durationMs, segments, audioOffsetMs },
    segments,
    findings,
    actionItems,
    replayTrim: null,
    replayPlayheadMs: 0,
    selectedFindingId: null,
  });

  log.info("trim: applied", { durationMs, audioOffsetMs, segments: segments.length });
}
