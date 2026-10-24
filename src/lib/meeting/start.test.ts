import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The meeting start gate: which provider setups open a real capture session,
// which are refused (and with which toast), and what the UI goes through on
// the way. Tauri, the toast layer and the mock stream are stand-ins; the store
// is the real one.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  toastLoading: vi.fn(() => "t1"),
  startMockStream: vi.fn(),
  openSettings: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    warning: vi.fn(),
    success: vi.fn(),
    message: mocks.toastMessage,
    loading: mocks.toastLoading,
    dismiss: vi.fn(),
  },
}));
vi.mock("../mockStream", () => ({ startMockStream: mocks.startMockStream, stopMockStream: vi.fn() }));
vi.mock("../nav/settings", () => ({ openSettings: mocks.openSettings }));
vi.mock("../dictionary", () => ({ recognitionTerms: () => ["Parley"] }));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));

import { useStore } from "../store";
import type { Settings } from "../types";
import { beginMeeting } from "./start";
import { liveSaves } from "../history/history";
import { translate } from "../../i18n/messages";

const base = useStore.getState().settings;
const session = { token: "sess_1", user: { id: "u1", name: "T", email: "t@example.com" }, activeOrganizationId: null };

/** Installed local models, as `local_stt_models` would report them. */
let localModels: { id: string; installed: boolean; downloading: boolean }[] = [];

function setup(over: Partial<Settings>, opts: { signedIn?: boolean; tauri?: boolean } = {}) {
  useStore.setState({
    settings: { ...base, language: "en", inputDevice: "Mic A", ...over },
    cloudAuth: opts.signedIn ? session : null,
    meetingStatus: "idle",
  });
  if (opts.tauri === false) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

/** Every meeting status the store went through during `fn`. */
async function statusesDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const un = useStore.subscribe((s, prev) => {
    if (s.meetingStatus !== prev.meetingStatus) seen.push(s.meetingStatus);
  });
  try {
    await fn();
  } finally {
    un();
  }
  return seen;
}

const startCalls = () => mocks.invoke.mock.calls.filter((c) => c[0] === "start_meeting").map((c) => c[1]);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "local_stt_models" ? localModels : undefined));
  mocks.toastError.mockReset();
  mocks.toastMessage.mockReset();
  mocks.toastLoading.mockClear();
  mocks.startMockStream.mockReset();
  localModels = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("beginMeeting", () => {
  it("opens a BYOK capture session with the trimmed key and no relay", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: " sk \n" });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording"]);
    expect(startCalls()).toEqual([
      {
        provider: "soniox",
        apiKey: "sk",
        diarization: true,
        inputDevice: "Mic A",
        relayUrl: undefined,
        model: null,
        vocabulary: ["Parley"],
        // The store's id for this meeting, echoed back on its recording events.
        meetingId: useStore.getState().liveMeetingId,
      },
    ]);
    expect(useStore.getState().liveMeetingId).toEqual(expect.any(String));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("relays hosted Parley with the session token", async () => {
    setup({ transcriptionProvider: "parley" }, { signedIn: true });
    await beginMeeting();
    expect(startCalls()).toEqual([
      expect.objectContaining({
        provider: "parley",
        apiKey: "sess_1",
        diarization: true,
        relayUrl: expect.stringMatching(/\/stt\/v2\/stream\?feature=meeting$/),
        model: null,
      }),
    ]);
  });

  it("runs the selected on-device model once it is downloaded", async () => {
    localModels = [{ id: "whisper-small-q5_1", installed: true, downloading: false }];
    setup({ transcriptionProvider: "local", localSttModel: "whisper-small-q5_1" });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording"]);
    expect(startCalls()).toEqual([
      expect.objectContaining({ provider: "local", apiKey: "local", diarization: false, model: "whisper-small-q5_1" }),
    ]);
  });

  it.each([
    ["missing", []],
    ["downloading", [{ id: "whisper-small-q5_1", installed: true, downloading: true }]],
    ["not installed", [{ id: "whisper-small-q5_1", installed: false, downloading: false }]],
  ])("refuses a local model that is %s, before the UI says recording", async (_, models) => {
    localModels = models;
    setup({ transcriptionProvider: "local", localSttModel: "whisper-small-q5_1" });
    expect(await statusesDuring(beginMeeting)).toEqual([]);
    expect(startCalls()).toEqual([]);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const [text, opts] = mocks.toastError.mock.calls[0];
    expect(text).toBe(translate("en", "localStt.error.notReady"));
    expect(opts).toMatchObject({ duration: 8000, action: { label: translate("en", "ai.fail.openSettings") } });
    opts.action.onClick();
    expect(mocks.openSettings).toHaveBeenCalledWith("transcription");
  });

  it("tells a signed-out hosted user to sign in, and backs out of recording", async () => {
    setup({ transcriptionProvider: "parley" }, { signedIn: false });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording", "stopped"]);
    expect(startCalls()).toEqual([]);
    expect(mocks.toastError.mock.calls).toEqual([[translate("en", "meeting.error.signin")]]);
    expect(mocks.startMockStream).not.toHaveBeenCalled();
  });

  it("plays the dev mock stream when no key is set in a dev build", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "" });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording"]);
    expect(mocks.startMockStream).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(startCalls()).toEqual([]);
  });

  it("refuses a missing key in a production build and points at Settings", async () => {
    vi.stubEnv("DEV", false);
    setup({ transcriptionProvider: "deepgram", deepgramApiKey: "" });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording", "stopped"]);
    expect(mocks.startMockStream).not.toHaveBeenCalled();
    const [text, opts] = mocks.toastError.mock.calls[0];
    expect(text).toBe(translate("en", "meeting.error.noSttKey"));
    expect(opts).toMatchObject({ duration: 8000, action: { label: translate("en", "ai.fail.openSettings") } });
  });

  it("outside Tauri never opens a session: a key alone falls through to the mock", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "sk" }, { tauri: false });
    await beginMeeting();
    expect(startCalls()).toEqual([]);
    expect(mocks.startMockStream).toHaveBeenCalledTimes(1);
  });

  it("outside Tauri skips the local model check (mock stream)", async () => {
    setup({ transcriptionProvider: "local" }, { tauri: false });
    await beginMeeting();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.startMockStream).toHaveBeenCalledTimes(1);
  });

  it("outside Tauri a signed-in hosted user still gets the sign-in toast", async () => {
    setup({ transcriptionProvider: "parley" }, { signedIn: true, tauri: false });
    await beginMeeting();
    expect(mocks.toastError.mock.calls).toEqual([[translate("en", "meeting.error.signin")]]);
  });

  it("backs out of recording when the backend refuses to start", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "sk" });
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_meeting") throw new Error("no input device");
      return undefined;
    });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording", "stopped"]);
    expect(mocks.toastError).not.toHaveBeenCalled();
    // A refused start leaves no save to wait for.
    expect(liveSaves.hasPending()).toBe(false);
  });

  // The overnight merge: Start pressed while a meeting runs used to wipe the
  // cockpit while the backend kept extending the old recording.
  it("never starts silently over a meeting that is recording", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "sk" });
    useStore.setState({ meetingStatus: "recording", liveMeetingId: "running", segments: [] });
    expect(await statusesDuring(beginMeeting)).toEqual([]);
    expect(startCalls()).toEqual([]);
    expect(mocks.toastMessage).toHaveBeenCalledWith(
      translate("en", "meeting.start.alreadyRecording"),
      expect.objectContaining({ action: expect.objectContaining({ label: translate("en", "meeting.start.endAndStartNew") }) }),
    );
    expect(useStore.getState().liveMeetingId).toBe("running");
  });

  it("stops and saves a recording this window lost before starting the next", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "sk" });
    let active: object | null = { meetingId: "lost", startedAtMs: 5 };
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "active_meeting") return active;
      if (cmd === "stop_meeting") {
        active = null;
        // The recording event's save settles the wait.
        setTimeout(() => liveSaves.settle("lost"), 0);
      }
      return undefined;
    });
    expect(await statusesDuring(beginMeeting)).toEqual(["recording"]);
    const cmds = mocks.invoke.mock.calls.map((c) => c[0]);
    expect(cmds.indexOf("stop_meeting")).toBeLessThan(cmds.indexOf("start_meeting"));
    expect(mocks.toastLoading).toHaveBeenCalledWith(translate("en", "meeting.start.savingPrevious"));
    expect(startCalls()[0]).toMatchObject({ meetingId: useStore.getState().liveMeetingId });
    expect(useStore.getState().liveMeetingId).not.toBe("lost");
  });

  it("ignores a second start while the first is still in flight", async () => {
    setup({ transcriptionProvider: "soniox", sonioxApiKey: "sk" });
    let release: () => void = () => {};
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = beginMeeting();
    await beginMeeting();
    release();
    await first;
    expect(startCalls()).toHaveLength(1);
  });
});
