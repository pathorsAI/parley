import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useStore, type ReplayTrim } from "../store";
import { log } from "../log";

interface TrimResult {
  audioPath: string;
  durationMs: number;
}

/**
 * Destructively trim the loaded recording to `[trim.startMs, trim.endMs]`:
 *  - Rust re-encodes the kept audio range to a fresh 16 kHz Opus file.
 *  - The transcript, findings, and action items are rebased to that new 0-based
 *    timeline (anything outside the window is dropped; in-window items shift left
 *    by `startMs`).
 *  - The replay session points at the new (shorter) audio; the playhead resets.
 *
 * Recoverable: re-uploading the original restores the full recording (cached).
 */
export async function trimRecording(trim: ReplayTrim): Promise<void> {
  const { replay } = useStore.getState();
  if (!replay?.audioPath) throw new Error("No recording loaded to trim.");

  const startMs = Math.max(0, Math.round(trim.startMs));
  const endMs = Math.round(trim.endMs);
  log.info("trim: start", { startMs, endMs });

  const res = await invoke<TrimResult>("trim_recording", {
    audioPath: replay.audioPath,
    startMs,
    endMs,
  });

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

  useStore.setState({
    replay: {
      ...replay,
      audioPath: res.audioPath,
      audioSrc: convertFileSrc(res.audioPath),
      durationMs: res.durationMs,
      segments,
    },
    segments,
    findings,
    actionItems,
    replayTrim: null,
    replayPlayheadMs: 0,
    selectedFindingId: null,
  });

  log.info("trim: applied", { durationMs: res.durationMs, segments: segments.length });
}
