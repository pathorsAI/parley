import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The voice-typing cue (#607): that it asks the backend to play, and that a
// sound that fails never fails the caller.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));

import { playVoiceTypingCue } from "./cue";

function setup(opts: { tauri?: boolean } = {}) {
  if (opts.tauri === false) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.log.warn.mockReset();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("playVoiceTypingCue", () => {
  it("asks the backend to play each cue", async () => {
    setup();
    expect(await playVoiceTypingCue("start")).toBe(true);
    expect(await playVoiceTypingCue("stop")).toBe(true);
    expect(mocks.invoke.mock.calls).toEqual([
      ["play_cue", { cue: "start" }],
      ["play_cue", { cue: "stop" }],
    ]);
  });

  it("plays nothing outside Tauri", async () => {
    setup({ tauri: false });
    expect(await playVoiceTypingCue("stop")).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("logs a failed sound instead of throwing", async () => {
    setup();
    mocks.invoke.mockRejectedValueOnce(new Error("no sound"));
    expect(await playVoiceTypingCue("start")).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith("voice-typing: cue failed", {
      cue: "start",
      error: "Error: no sound",
    });
  });
});
