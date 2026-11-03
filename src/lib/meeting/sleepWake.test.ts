import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A meeting the computer slept through is ended (and saved) on wake.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notify: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../mockStream", () => ({ startMockStream: vi.fn(), stopMockStream: vi.fn() }));
vi.mock("../dictionary", () => ({ recognitionTerms: () => [] }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));
vi.mock("../notify", () => ({ notify: { message: mocks.notify, success: vi.fn(), error: vi.fn() } }));

import { useStore } from "../store";
import { endsMeetingOnWake, handleSystemWake, WAKE_END_AFTER_MS } from "./sleepWake";

const base = useStore.getState().settings;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.notify.mockReset();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useStore.setState({
    settings: { ...base, language: "en", transcriptionProvider: "soniox", sonioxApiKey: "sk" },
    cloudAuth: null,
    meetingStatus: "recording",
    isFinalizingMeeting: false,
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("endsMeetingOnWake", () => {
  it("ends a recording or paused meeting after a long sleep only", () => {
    expect(endsMeetingOnWake(WAKE_END_AFTER_MS, "recording")).toBe(true);
    expect(endsMeetingOnWake(WAKE_END_AFTER_MS, "paused")).toBe(true);
    expect(endsMeetingOnWake(WAKE_END_AFTER_MS - 1, "recording")).toBe(false);
    expect(endsMeetingOnWake(10 * WAKE_END_AFTER_MS, "idle")).toBe(false);
    expect(endsMeetingOnWake(10 * WAKE_END_AFTER_MS, "stopped")).toBe(false);
  });
});

describe("handleSystemWake", () => {
  it("ends and saves the meeting after a night asleep, untrimmed, and says so", async () => {
    await handleSystemWake(10 * 3_600_000);
    expect(mocks.invoke.mock.calls).toEqual([["stop_meeting", {}]]);
    expect(useStore.getState().meetingStatus).toBe("stopped");
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(String(mocks.notify.mock.calls[0][0])).toContain("600 minutes");
  });

  it("leaves a meeting alone after a short nap", async () => {
    await handleSystemWake(5 * 60_000);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useStore.getState().meetingStatus).toBe("recording");
  });
});
