import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The silence guard: when it asks, when it gives up asking, when it ends the
// meeting, and how much of the recording it keeps.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  requestUserAttention: vi.fn(),
  notify: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention: mocks.requestUserAttention }),
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
vi.mock("../mockStream", () => ({ startMockStream: vi.fn(), stopMockStream: vi.fn() }));
vi.mock("../dictionary", () => ({ recognitionTerms: () => [] }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));
vi.mock("../notify", () => ({ notify: { message: mocks.notify, success: vi.fn(), error: vi.fn() } }));

import { useStore } from "../store";
import type { TranscriptSegment } from "../types";
import {
  broughtSpeech,
  initSilenceGuard,
  keepRecording,
  RECONNECTING_PROMPT_MS,
  recordingKeepMs,
  SILENCE_GRACE_MS,
  SILENCE_PROMPT_MS,
  silenceStep,
  TRIM_MARGIN_MS,
} from "./silenceGuard";

const seg = (id: string, text: string, endMs: number): TranscriptSegment => ({
  id,
  source: "mix",
  speaker: 0,
  text,
  isFinal: true,
  startMs: Math.max(0, endMs - 1_000),
  endMs,
});

describe("silenceStep", () => {
  it("asks once nothing has been transcribed for the prompt window", () => {
    expect(silenceStep(SILENCE_PROMPT_MS - 1, 0, null)).toBe("none");
    expect(silenceStep(SILENCE_PROMPT_MS, 0, null)).toBe("prompt");
  });

  it("ends the meeting when the question goes unanswered for the grace", () => {
    const asked = SILENCE_PROMPT_MS;
    expect(silenceStep(asked + SILENCE_GRACE_MS - 1, 0, asked)).toBe("none");
    expect(silenceStep(asked + SILENCE_GRACE_MS, 0, asked)).toBe("end");
  });

  it("withdraws the question when someone speaks after it", () => {
    const asked = SILENCE_PROMPT_MS;
    expect(silenceStep(asked + 10_000, asked + 5_000, asked)).toBe("dismiss");
  });

  it("asks straight away when the clock jumped past the window (a Mac waking up)", () => {
    expect(silenceStep(8 * 3_600_000, 0, null)).toBe("prompt");
  });
});

describe("silenceStep while the link is reconnecting", () => {
  it("asks only after the long window", () => {
    expect(silenceStep(SILENCE_PROMPT_MS * 2, 0, null, false)).toBe("none");
    expect(silenceStep(RECONNECTING_PROMPT_MS, 0, null, false)).toBe("prompt");
  });

  it("holds a question asked while live instead of ending mid-outage", () => {
    const askedAt = SILENCE_PROMPT_MS;
    expect(silenceStep(askedAt + SILENCE_GRACE_MS * 3, 0, askedAt, false)).toBe("none");
    // …until the silence is long enough to end on regardless.
    expect(silenceStep(RECONNECTING_PROMPT_MS, 0, askedAt, false)).toBe("end");
    // Speech still withdraws it.
    expect(silenceStep(askedAt + 10_000, askedAt + 5_000, askedAt, false)).toBe("dismiss");
  });
});

describe("recordingKeepMs", () => {
  it("keeps up to the last transcribed words plus the margin", () => {
    expect(recordingKeepMs([seg("a", "hi", 10_000), seg("b", "bye", 3_600_000), seg("c", "   ", 3_700_000)])).toBe(
      3_600_000 + TRIM_MARGIN_MS,
    );
  });

  it("has nothing to anchor a cut to when nobody spoke", () => {
    expect(recordingKeepMs([])).toBeUndefined();
    expect(recordingKeepMs([seg("a", " ", 5_000)])).toBeUndefined();
  });
});

describe("broughtSpeech", () => {
  it("sees a new or grown segment with words, not an unchanged list or blank text", () => {
    const a = seg("a", "hi", 1_000);
    expect(broughtSpeech([a], [a])).toBe(false);
    expect(broughtSpeech([a], [a, seg("b", "there", 2_000)])).toBe(true);
    expect(broughtSpeech([a], [seg("a", "hi there", 1_500)])).toBe(true);
    expect(broughtSpeech([a], [a, seg("b", "", 2_000)])).toBe(false);
  });
});

describe("initSilenceGuard", () => {
  const base = useStore.getState().settings;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.requestUserAttention.mockReset();
    mocks.requestUserAttention.mockResolvedValue(undefined);
    mocks.notify.mockReset();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useStore.setState({
      settings: { ...base, transcriptionProvider: "soniox", sonioxApiKey: "sk" },
      cloudAuth: null,
      meetingStatus: "idle",
      isFinalizingMeeting: false,
      silencePromptAt: null,
      transcriptionLink: "live",
      segments: [],
    });
    stop = initSilenceGuard();
    useStore.setState({ meetingStatus: "recording" });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("asks, then ends the meeting and keeps the recording up to just after the last words", async () => {
    useStore.setState({ segments: [seg("a", "see you", 60_000)] });
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS + 5_000);
    expect(useStore.getState().silencePromptAt).not.toBeNull();
    expect(mocks.requestUserAttention).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SILENCE_GRACE_MS + 5_000);
    expect(mocks.invoke.mock.calls).toEqual([["stop_meeting", { keepMs: 60_000 + TRIM_MARGIN_MS }]]);
    expect(useStore.getState().meetingStatus).toBe("stopped");
    expect(useStore.getState().silencePromptAt).toBeNull();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("never asks while people keep talking", async () => {
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS / 3);
      useStore.setState({ segments: [...useStore.getState().segments, seg(`s${i}`, "still here", i * 1_000)] });
    }
    expect(useStore.getState().silencePromptAt).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("withdraws the question when someone speaks, and Keep recording restarts the clock", async () => {
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS + 5_000);
    expect(useStore.getState().silencePromptAt).not.toBeNull();
    useStore.setState({ segments: [seg("a", "oh, one more thing", 1_000)] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useStore.getState().silencePromptAt).toBeNull();

    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS);
    expect(useStore.getState().silencePromptAt).not.toBeNull();
    keepRecording();
    expect(useStore.getState().silencePromptAt).toBeNull();
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS - 10_000);
    expect(useStore.getState().silencePromptAt).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not count a pause as silence", async () => {
    useStore.setState({ meetingStatus: "paused" });
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS * 2);
    useStore.setState({ meetingStatus: "recording" });
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS - 10_000);
    expect(useStore.getState().silencePromptAt).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // The overnight merge: every reconnect report used to restart the clock, so
  // a meeting whose link kept dropping was never asked about at all.
  it("does not let a reconnecting link restart the clock", async () => {
    useStore.setState({ transcriptionLink: "reconnecting" });
    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS * 2);
    // Held while the link is down: nothing transcribed proves nothing.
    expect(useStore.getState().silencePromptAt).toBeNull();
    useStore.setState({ transcriptionLink: "live" });
    await vi.advanceTimersByTimeAsync(5_000);
    // Back live with no words for 30 minutes: ask now.
    expect(useStore.getState().silencePromptAt).not.toBeNull();
  });

  it("ends a meeting whose link never comes back, keeping the whole recording", async () => {
    useStore.setState({ segments: [seg("a", "see you", 60_000)], transcriptionLink: "reconnecting" });
    await vi.advanceTimersByTimeAsync(RECONNECTING_PROMPT_MS + 5_000);
    expect(useStore.getState().silencePromptAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(SILENCE_GRACE_MS + 5_000);
    // No trim: words after the last transcribed ones may be in the audio.
    expect(mocks.invoke.mock.calls).toEqual([["stop_meeting", {}]]);
    expect(useStore.getState().meetingStatus).toBe("stopped");
  });
});
