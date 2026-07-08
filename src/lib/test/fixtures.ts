// Deterministic fixtures shared across the test suite. No randomness, no clocks,
// no network — every value here is fixed so assertions stay stable.
import type { TranscriptSegment } from "../types";
import type { ReplaySession } from "../replay/types";

/** Build a transcript segment with sensible defaults; override any field. */
export function seg(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: overrides.id ?? "s1",
    source: overrides.source ?? "them",
    speaker: overrides.speaker ?? 1,
    text: overrides.text ?? "hello",
    isFinal: overrides.isFinal ?? true,
    startMs: overrides.startMs ?? 0,
    endMs: overrides.endMs ?? 1000,
    ...overrides,
  };
}

/** Build a replay session wrapping the given segments. */
export function replaySession(
  segments: TranscriptSegment[],
  overrides: Partial<ReplaySession> = {}
): ReplaySession {
  return {
    id: "rec-1",
    name: "meeting.wav",
    // Fake, non-shared path — a fixture string only, never touched on disk.
    // Kept out of any world-writable temp dir (e.g. /tmp) on purpose.
    audioPath: "/recordings/meeting.wav",
    audioSrc: "asset://meeting.wav",
    durationMs: 60_000,
    createdAt: 0,
    segments,
    speakerNames: {},
    ...overrides,
  };
}
