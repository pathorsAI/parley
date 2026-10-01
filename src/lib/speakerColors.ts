import type { TranscriptSegment } from "./types";

type SpeakerLike = Pick<TranscriptSegment, "source" | "speaker">;

// Speakers don't get hues: names render as plain text everywhere. The only
// colour is in the small identity dots of the speaker-naming UIs — blue
// (primary) for your own voice, a neutral grey for everyone else.
const ME_DOT = "bg-primary";
const OTHER_DOT = "bg-muted-foreground/45";

// The primary mic voice (me, speaker ≤ 1) is "You".
function isPrimaryMe(seg: SpeakerLike): boolean {
  return seg.source === "me" && (seg.speaker || 1) <= 1;
}

export function speakerDotClass(seg: SpeakerLike): string {
  return isPrimaryMe(seg) ? ME_DOT : OTHER_DOT;
}
