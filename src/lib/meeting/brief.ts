// The per-meeting frame handed to every analysis prompt.

/**
 * The per-meeting context handed to every analysis prompt: the free-text context
 * plus the principled-negotiation setup (BATNA / target / bottom line), each
 * clearly labelled so the model can reason about leverage, the ZOPA, and how close
 * ME is to walking away. Empty when nothing has been entered.
 */
export function meetingBriefText(s: {
  meetingContext: string;
  meetingBatna: string;
  meetingTarget: string;
  meetingFloor: string;
}): string {
  const parts: string[] = [];
  if (s.meetingContext.trim()) parts.push(s.meetingContext.trim());
  const setup: string[] = [];
  if (s.meetingBatna.trim()) setup.push(`My BATNA (best alternative if no deal): ${s.meetingBatna.trim()}`);
  if (s.meetingTarget.trim()) setup.push(`My target (what I'm aiming for): ${s.meetingTarget.trim()}`);
  if (s.meetingFloor.trim()) setup.push(`My bottom line / walk-away point: ${s.meetingFloor.trim()}`);
  if (setup.length) parts.push(`My negotiation setup —\n${setup.join("\n")}`);
  return parts.join("\n\n");
}
