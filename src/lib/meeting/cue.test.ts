import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recording cue (#607): whether it asks the backend to play, and that a
// sound that fails never fails the caller.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));

import { useStore } from "../store";
import { DEFAULT_SETTINGS } from "../store/defaults";
import { playCue, playStartCue, START_CUE_LEAD_MS } from "./cue";

const base = useStore.getState().settings;

function setup(enabled: boolean, opts: { tauri?: boolean } = {}) {
  useStore.setState({ settings: { ...base, recordingCueEnabled: enabled } });
  if (opts.tauri === false) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.log.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("playCue", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.recordingCueEnabled).toBe(true);
  });

  it("asks the backend to play the cue when the setting is on", async () => {
    setup(true);
    expect(await playCue("start")).toBe(true);
    expect(await playCue("stop")).toBe(true);
    expect(mocks.invoke.mock.calls).toEqual([
      ["play_cue", { cue: "start" }],
      ["play_cue", { cue: "stop" }],
    ]);
  });

  it("plays nothing when the setting is off", async () => {
    setup(false);
    expect(await playCue("start")).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("plays nothing outside Tauri", async () => {
    setup(true, { tauri: false });
    expect(await playCue("stop")).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("logs a failed sound instead of throwing", async () => {
    setup(true);
    mocks.invoke.mockRejectedValueOnce(new Error("no sound"));
    expect(await playCue("start")).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith("meeting: recording cue failed", {
      cue: "start",
      error: "Error: no sound",
    });
  });
});

describe("playStartCue", () => {
  it("waits for the cue's click before resolving", async () => {
    vi.useFakeTimers();
    setup(true);
    let done = false;
    const p = playStartCue().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(START_CUE_LEAD_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("does not wait when no cue plays", async () => {
    vi.useFakeTimers();
    setup(false);
    await playStartCue();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
