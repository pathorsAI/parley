import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The recorder controls: what each one does to the store and which pipeline
// it tells (the Rust capture session, or the dev mock stream).
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  stopMockStream: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../mockStream", () => ({ startMockStream: vi.fn(), stopMockStream: mocks.stopMockStream }));
vi.mock("../dictionary", () => ({ recognitionTerms: () => [] }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));

import { useStore } from "../store";
import type { MeetingStatus } from "../types";
import { cancelActiveMeeting, endMeeting, recoverOrphanedMeeting, stopBackendMeeting, toggleMeetingPause } from "./controls";

const base = useStore.getState().settings;

function setup(opts: { key: string; tauri?: boolean; status?: MeetingStatus }) {
  useStore.setState({
    settings: { ...base, transcriptionProvider: "soniox", sonioxApiKey: opts.key },
    cloudAuth: null,
    meetingStatus: opts.status ?? "recording",
    isFinalizingMeeting: false,
  });
  if (opts.tauri === false) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

const commands = () => mocks.invoke.mock.calls.map((c) => (c.length > 1 ? [c[0], c[1]] : [c[0]]));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.stopMockStream.mockReset();
  for (const fn of Object.values(mocks.log)) fn.mockReset();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("endMeeting", () => {
  it("stops the real session and shows finalizing until the save reports back", async () => {
    setup({ key: "sk" });
    await endMeeting();
    expect(commands()).toEqual([["stop_meeting", {}]]);
    expect(useStore.getState().meetingStatus).toBe("stopped");
    expect(useStore.getState().isFinalizingMeeting).toBe(true);
    expect(mocks.stopMockStream).not.toHaveBeenCalled();
  });

  it("clears finalizing when the backend stop fails", async () => {
    setup({ key: "sk" });
    mocks.invoke.mockRejectedValueOnce(new Error("gone"));
    await endMeeting();
    expect(useStore.getState().isFinalizingMeeting).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledWith("meeting: stop failed", { error: "Error: gone" });
  });

  it("stops the mock stream when there is no real pipeline", async () => {
    for (const opts of [{ key: "" }, { key: "sk", tauri: false }]) {
      mocks.stopMockStream.mockReset();
      setup(opts);
      await endMeeting();
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.stopMockStream).toHaveBeenCalledTimes(1);
      expect(useStore.getState().isFinalizingMeeting).toBe(false);
    }
  });
});

describe("toggleMeetingPause", () => {
  it("pauses then resumes, telling the backend each time", () => {
    setup({ key: "sk" });
    toggleMeetingPause();
    expect(useStore.getState().meetingStatus).toBe("paused");
    toggleMeetingPause();
    expect(useStore.getState().meetingStatus).toBe("recording");
    expect(commands()).toEqual([
      ["set_meeting_paused", { paused: true }],
      ["set_meeting_paused", { paused: false }],
    ]);
  });

  it("only flips the store on the mock pipeline", () => {
    setup({ key: "" });
    toggleMeetingPause();
    expect(useStore.getState().meetingStatus).toBe("paused");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("cancelActiveMeeting", () => {
  it("discards the real session", async () => {
    setup({ key: "sk" });
    await cancelActiveMeeting();
    expect(commands()).toEqual([["cancel_meeting"]]);
    expect(useStore.getState().meetingStatus).toBe("idle");
  });

  it("logs a failed backend cancel and still leaves the UI idle", async () => {
    setup({ key: "sk" });
    mocks.invoke.mockRejectedValueOnce("nope");
    await cancelActiveMeeting();
    expect(useStore.getState().meetingStatus).toBe("idle");
    expect(mocks.log.error).toHaveBeenCalledWith("meeting: cancel failed", { error: "nope" });
  });

  it("stops the mock stream when there is no real pipeline", async () => {
    setup({ key: "" });
    await cancelActiveMeeting();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.stopMockStream).toHaveBeenCalledTimes(1);
  });
});

describe("stopBackendMeeting", () => {
  it("sends stop_meeting with an empty argument object and logs a failure with the caller's fields", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("x"));
    await stopBackendMeeting("meeting: stop after backend error failed", { code: "quota" });
    expect(mocks.invoke.mock.calls).toEqual([["stop_meeting", {}]]);
    expect(mocks.log.warn).toHaveBeenCalledWith("meeting: stop after backend error failed", {
      code: "quota",
      error: "Error: x",
    });
  });
});

describe("endMeeting with a trim", () => {
  it("passes keepMs to the backend stop", async () => {
    setup({ key: "sk" });
    await endMeeting({ keepMs: 90_000 });
    expect(commands()).toEqual([["stop_meeting", { keepMs: 90_000 }]]);
  });
});

describe("recoverOrphanedMeeting", () => {
  it("stops and keeps a recording the backend is making for a meeting this window lost", async () => {
    setup({ key: "sk", status: "idle" });
    useStore.setState({ transcriptionDropped: false });
    mocks.invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "meeting_active" ? true : undefined));
    await recoverOrphanedMeeting();
    expect(commands()).toEqual([["meeting_active"], ["stop_meeting", {}]]);
    expect(useStore.getState().transcriptionDropped).toBe(true);
  });

  it("leaves the backend alone when nothing is recording", async () => {
    setup({ key: "sk", status: "idle" });
    mocks.invoke.mockResolvedValue(false);
    await recoverOrphanedMeeting();
    expect(commands()).toEqual([["meeting_active"]]);
  });

  it("leaves a meeting this window is running alone", async () => {
    setup({ key: "sk", status: "recording" });
    mocks.invoke.mockResolvedValue(true);
    await recoverOrphanedMeeting();
    expect(commands()).toEqual([["meeting_active"]]);
  });
});
