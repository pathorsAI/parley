// "Is a meeting running?" for the slice creators. The answer lives in the live
// store (../store.ts → useLiveStore), which is built FROM these slices, so a
// slice can't import it without a cycle; store.ts installs the probe instead.

let probe: () => boolean = () => false;

/** Installed once by store.ts. */
export function setLiveMeetingProbe(fn: () => boolean): void {
  probe = fn;
}

/** A draft was just taken to record (takeDraft): the prep now holds THAT
 *  draft, not the loaded recording's context. Read once by the meeting start. */
let draftTaken = false;
export function noteDraftTaken(): void {
  draftTaken = true;
}
export function consumeDraftTaken(): boolean {
  const was = draftTaken;
  draftTaken = false;
  return was;
}

/** A meeting is recording or paused (in the live store). */
export function liveMeetingRunning(): boolean {
  return probe();
}
