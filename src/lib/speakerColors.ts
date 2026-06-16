import type { TranscriptSegment } from "./types";

type SpeakerLike = Pick<TranscriptSegment, "source" | "speaker">;

// Own mic is sky; remote diarized speakers cycle a fixed palette.
const ME_BADGE = "bg-sky-500/15 text-sky-300 ring-sky-500/30";
const PALETTE_BADGE = [
  "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
];
const ME_DOT = "bg-sky-400";
const PALETTE_DOT = ["bg-amber-400", "bg-violet-400", "bg-emerald-400", "bg-rose-400", "bg-cyan-400"];

// The primary mic voice (me, speaker ≤ 1) is "You" (sky). Everyone else cycles
// the palette; remote speakers are offset so they don't collide with mic ones.
function isPrimaryMe(seg: SpeakerLike): boolean {
  return seg.source === "me" && (seg.speaker || 1) <= 1;
}

function idx(seg: SpeakerLike): number {
  const n = seg.source === "me" ? (seg.speaker || 1) : (seg.speaker || 1) + 2;
  return (n - 1 + PALETTE_BADGE.length) % PALETTE_BADGE.length;
}

export function speakerBadgeClass(seg: SpeakerLike): string {
  return isPrimaryMe(seg) ? ME_BADGE : PALETTE_BADGE[idx(seg)];
}

export function speakerDotClass(seg: SpeakerLike): string {
  return isPrimaryMe(seg) ? ME_DOT : PALETTE_DOT[idx(seg)];
}
