// Types for the local meeting history (recording + analysis saved on disk).
//
// A `HistoryEntry` is the full snapshot persisted to `meta.json`; loading one
// reconstructs a `ReplaySession` + analysis state so the replay UI works
// unchanged. `HistoryEntrySummary` is the lightweight card the history grid
// lists (written to `summary.json` so listing never parses the full entries).

import type { ActionItem, DeliveryAssessment, TimelineEvent, TranscriptSegment } from "../types";

/** Where a saved session came from: a captured live meeting or an upload. */
export type HistorySource = "live" | "upload";

/** The full saved session — everything needed to replay it and show its analysis. */
export interface HistoryEntry {
  id: string;
  /** Display title — live: "即時會議 · <date>"; upload: the original file name. */
  title: string;
  source: HistorySource;
  createdAt: number;
  durationMs: number;
  /** Diarized + timestamped transcript (same shape as live/replay). */
  segments: TranscriptSegment[];
  /** Speaker-key → display-name map (`{}` if none). */
  speakerNames: Record<string, string>;
  /** Whole-recording analysis findings (eval-matched + AI "extra"). */
  findings: TimelineEvent[];
  /** Post-meeting follow-ups generated from the analysis. */
  actionItems: ActionItem[];
  /** Per-meeting free-text context + principled-negotiation setup. */
  meetingContext: string;
  meetingBatna: string;
  meetingTarget: string;
  meetingFloor: string;
  /** Recording file name within the entry folder ("audio.ogg"), or null if none. */
  audio: string | null;
  /** Saved LLM delivery assessment (tone + fillers + summary). Optional: entries
   *  saved before this field existed omit it → the panel recomputes once on open. */
  deliveryAssessment?: DeliveryAssessment | null;
  /** Acoustically measured articulation rate (syllables/sec) for the post-call
   *  pace read. Optional for back-compat; absent/0 → the panel falls back to the
   *  LLM's coarse pace label. */
  speechRateHz?: number | null;
}

/** The card shown in the history grid — small, so listing stays cheap. */
export interface HistoryEntrySummary {
  id: string;
  title: string;
  source: HistorySource;
  createdAt: number;
  durationMs: number;
  /** Distinct speaker count among spoken segments. */
  speakerCount: number;
  /** Number of analysis findings. */
  findingsCount: number;
  /** Number of post-meeting action items. Optional: entries saved before this
   *  field existed simply omit it (the card then hides the action-item stat). */
  actionItemsCount?: number;
  hasAudio: boolean;
  /** First spoken line of the transcript, for a preview. */
  snippet: string;
}
