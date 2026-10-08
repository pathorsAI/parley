import { afterEach, describe, expect, it, vi } from "vitest";

// The replay player's error → fallback flow: a recording the webview can't
// decode gets ONE retry as a WAV decoded in Rust, and otherwise a visible error
// instead of a play button that silently does nothing.

const { invoke, log } = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args: Record<string, unknown>) => Promise<unknown>>(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock("../../lib/log", () => ({ log }));

import {
  createPlaybackRecovery,
  describeMediaError,
  isDecodeFailure,
  type PlaybackState,
} from "./playbackRecovery";

const AUDIO = "/history/rec-1/audio.ogg";
const WAV = "/cache/playback/abc.wav";

function arrange(audioPath = AUDIO) {
  const states: PlaybackState[] = [];
  const recovery = createPlaybackRecovery({
    audioPath,
    audioSrc: `asset://localhost/${encodeURIComponent(audioPath)}`,
    onState: (s) => states.push(s),
  });
  return { recovery, states };
}

afterEach(() => {
  invoke.mockReset();
  log.error.mockClear();
});

describe("describeMediaError", () => {
  it("names the MediaError code and keeps the browser's message", () => {
    expect(describeMediaError({ code: 4, message: "Unsupported format" })).toEqual({
      code: 4,
      message: "MEDIA_ERR_SRC_NOT_SUPPORTED: Unsupported format",
    });
    expect(describeMediaError(null)).toEqual({ code: null, message: "unknown media error" });
  });

  it("only decode and unsupported-source errors are worth a decode fallback", () => {
    expect([1, 2, 3, 4, null].map(isDecodeFailure)).toEqual([false, false, true, true, false]);
  });
});

describe("createPlaybackRecovery", () => {
  it("decodes to WAV on the first decode error and hands back its asset URL", async () => {
    invoke.mockResolvedValue(WAV);
    const { recovery, states } = arrange();
    const src = await recovery.handleError({ code: 3, message: "MEDIA_ERR_DECODE" });
    expect(invoke).toHaveBeenCalledWith("prepare_playback_fallback", { audioPath: AUDIO });
    expect(src).toBe(`asset://localhost/${encodeURIComponent(WAV)}`);
    expect(states).toEqual([{ kind: "repairing" }, { kind: "ok" }]);
    // The original failure is in the log file, with the src that failed.
    expect(log.error).toHaveBeenCalledWith("replay: audio element error", expect.objectContaining({ code: 3 }));
  });

  it("an error from the fallback itself is final — no second conversion", async () => {
    invoke.mockResolvedValue(WAV);
    const { recovery, states } = arrange();
    await recovery.handleError({ code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" });
    const again = await recovery.handleError({ code: 3, message: "MEDIA_ERR_DECODE" });
    expect(again).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toEqual({ kind: "failed", error: { code: 3, message: "MEDIA_ERR_DECODE" } });
  });

  it("shows the decode failure when the conversion fails too", async () => {
    invoke.mockRejectedValue("could not decode the audio: not an Ogg stream");
    const { recovery, states } = arrange();
    expect(await recovery.handleError({ code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" })).toBeNull();
    const last = states[states.length - 1];
    expect(last?.kind).toBe("failed");
    expect(last?.kind === "failed" && last.error.message).toContain("could not decode the audio");
  });

  it("does not try to convert a network or aborted error", async () => {
    const { recovery, states } = arrange();
    expect(await recovery.handleError({ code: 2, message: "MEDIA_ERR_NETWORK" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(states).toEqual([{ kind: "failed", error: { code: 2, message: "MEDIA_ERR_NETWORK" } }]);
  });

  it("has nothing to convert without a file on disk", async () => {
    const { recovery, states } = arrange("");
    expect(await recovery.handleError({ code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(states[states.length - 1]?.kind).toBe("failed");
  });

  it("drops a fallback that lands after the player moved to another recording", async () => {
    let finish: (wav: string) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { recovery, states } = arrange();
    const pending = recovery.handleError({ code: 3, message: "MEDIA_ERR_DECODE" });
    // A → B while A's decode is still running.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    recovery.dispose();
    finish(WAV);
    expect(await pending).toBeNull();
    // Only the "repairing" reported before the switch; nothing after it.
    expect(states).toEqual([{ kind: "repairing" }]);
  });

  it("drops a failure that lands after the player moved on", async () => {
    let fail: (e: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    const { recovery, states } = arrange();
    const pending = recovery.handleError({ code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    recovery.dispose();
    fail("could not decode the audio");
    expect(await pending).toBeNull();
    expect(states).toEqual([{ kind: "repairing" }]);
  });

  it("ignores errors once disposed", async () => {
    const { recovery, states } = arrange();
    recovery.dispose();
    expect(await recovery.handleError({ code: 3, message: "MEDIA_ERR_DECODE" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });
});
