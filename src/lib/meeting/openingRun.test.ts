import { beforeEach, describe, expect, it } from "vitest";
import { useLiveStore } from "../store";
import type { TranscriptSegment } from "../types";
import { OPENING_MAX_MS } from "./opening";
import { retireOpeningIfDone } from "./openingRun";

const SCRIPT = "謝謝今天撥空，我們大概三十分鐘，想先聊導入進度、再看報價，最後確認下一步，這樣可以嗎？";
const INITIAL = useLiveStore.getState();

function line(text: string, source: "me" | "them", endMs: number): TranscriptSegment {
  return { id: `${source}-${endMs}`, source, speaker: 1, text, startMs: endMs - 1000, endMs, isFinal: true } as TranscriptSegment;
}

beforeEach(() => {
  useLiveStore.setState(INITIAL, true);
  useLiveStore.setState({ meetingOpening: { script: SCRIPT, smallTalk: [] } });
  useLiveStore.getState().startMeeting();
});

describe("retireOpeningIfDone", () => {
  it("leaves the card up while the opening has not been said", () => {
    useLiveStore.setState({ segments: [line("喂，聽得到嗎？", "me", 2000)] });
    retireOpeningIfDone();
    expect(useLiveStore.getState().openingDismissed).toBe(false);
  });

  it("retires it once the user has said it", () => {
    useLiveStore.setState({ segments: [line(SCRIPT, "me", 9000)] });
    retireOpeningIfDone();
    expect(useLiveStore.getState().openingDismissed).toBe(true);
  });

  it("retires it a few minutes in, said or not", () => {
    useLiveStore.setState({ meetingStartedAt: Date.now() - OPENING_MAX_MS - 1000 });
    retireOpeningIfDone();
    expect(useLiveStore.getState().openingDismissed).toBe(true);
  });

  it("a new meeting starts with the card up again", () => {
    useLiveStore.getState().dismissOpening();
    useLiveStore.getState().startMeeting();
    expect(useLiveStore.getState().openingDismissed).toBe(false);
  });
});
