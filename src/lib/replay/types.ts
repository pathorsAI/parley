// Types for the replay (uploaded-recording playback) feature.
//
// `ReplaySession` is the contract between ingest and the replay UI. It is also
// expected to live in `src/lib/types.ts` once the replay spine lands there; this
// local definition lets the replay module type-check standalone. If a canonical
// `ReplaySession` is added to `../types`, prefer importing it from there and drop
// this declaration.

import type { TranscriptSegment } from "../types";

/**
 * A fully transcribed uploaded recording ready for the replay UI to play and
 * scrub. `audioSrc` must support range requests / seeking.
 */
export interface ReplaySession {
  id: string;
  /** Original file name. */
  name: string;
  /** Absolute path to the audio file on disk. */
  audioPath: string;
  /** URL the webview `<audio>` loads and seeks (asset:// or blob:). */
  audioSrc: string;
  durationMs: number;
  /** Where playhead 0 sits inside the (un-shortened) audio file, in ms. A trim is
   *  instant + leaves the file alone: instead of re-encoding, we drop the
   *  out-of-window transcript/findings and shift this offset, so the player and
   *  the voice diarizer map the 0-based timeline back onto the original audio. */
  audioOffsetMs?: number;
  createdAt: number;
  /** Diarized + timestamped segments, same shape as live transcription. */
  segments: TranscriptSegment[];
  /** Optional speaker-number → display-name map (`{}` is fine). */
  speakerNames: Record<string, string>;
}
