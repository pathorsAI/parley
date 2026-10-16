import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The upload start gate and its failure messages: what `transcribeRecording`
// throws for each credential / local-model state, what it sends to
// `transcribe_file` when it may go ahead, and how a rejected on-device run is
// translated.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  recordUsage: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../usage/log", () => ({ recordUsage: mocks.recordUsage }));
vi.mock("../textNormalize", () => ({ normalizeTranscriptText: async (t: string) => t }));
vi.mock("../dictionary", () => ({ recognitionTerms: () => ["Parley"] }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings } from "../types";
import { transcribeRecording } from "./ingest";
import { translate } from "../../i18n/messages";

const base = useStore.getState().settings;
const session = { token: "sess_1", user: { id: "u1", name: "T", email: "t@example.com" }, activeOrganizationId: null };
let localModels: { id: string; installed: boolean; downloading: boolean }[] = [];
let transcribe: () => Promise<unknown> = async () => ({ segments: [], durationMs: 0, cached: true, speechRateHz: 0 });

const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, language: "en", ...over });
const fileCalls = () => mocks.invoke.mock.calls.filter((c) => c[0] === "transcribe_file").map((c) => c[1]);

async function failure(settings: Settings): Promise<unknown> {
  try {
    await transcribeRecording(settings, "/rec/call.m4a");
  } catch (e) {
    return e;
  }
  throw new Error("expected transcribeRecording to reject");
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useStore.setState({ cloudAuth: null });
  localModels = [];
  transcribe = async () => ({ segments: [], durationMs: 0, cached: true, speechRateHz: 0 });
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "local_stt_models") return localModels;
    if (cmd === "transcribe_file") return transcribe();
    return undefined;
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("transcribeRecording start gate", () => {
  it("refuses a missing BYOK key", async () => {
    const e = await failure(settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: " " }));
    expect((e as Error).message).toBe(translate("en", "ingest.error.noSttKey"));
    expect(fileCalls()).toEqual([]);
  });

  it("refuses signed-out hosted Parley with the same message", async () => {
    const e = await failure(settingsFor({ transcriptionProvider: "parley" }));
    expect((e as Error).message).toBe(translate("en", "ingest.error.noSttKey"));
  });

  it.each([
    ["missing", []],
    ["downloading", [{ id: "m1", installed: true, downloading: true }]],
  ])("refuses a local model that is %s", async (_, models) => {
    localModels = models;
    const e = await failure(settingsFor({ transcriptionProvider: "local", localSttModel: "m1", language: "zh-TW" }));
    expect((e as Error).message).toBe(translate("zh-TW", "localStt.error.notReadyUpload"));
    expect(fileCalls()).toEqual([]);
  });

  it("does not re-check upload support (the picker gate owns that)", async () => {
    await transcribeRecording(settingsFor({ transcriptionProvider: "gemini", geminiApiKey: "g" }), "/rec/call.m4a");
    expect(fileCalls()).toEqual([expect.objectContaining({ provider: "gemini" })]);
  });
});

describe("transcribeRecording payload", () => {
  it("sends a BYOK upload with the trimmed key and no batch URL", async () => {
    await transcribeRecording(
      settingsFor({ transcriptionProvider: "deepgram", deepgramApiKey: "dg \n" }),
      "/rec/call.m4a",
    );
    expect(fileCalls()).toEqual([
      expect.objectContaining({
        path: "/rec/call.m4a",
        provider: "deepgram",
        apiKey: "dg",
        model: null,
        languageHints: ["en"],
        vocabulary: ["Parley"],
        diarization: true,
        batchUrl: null,
      }),
    ]);
    expect(Object.keys(fileCalls()[0] as object).sort()).toEqual(
      ["apiKey", "batchUrl", "diarization", "languageHints", "model", "path", "provider", "vocabulary"],
    );
  });

  it("sends hosted Parley the session token and the cloud batch URL", async () => {
    useStore.setState({ cloudAuth: session });
    await transcribeRecording(settingsFor({ transcriptionProvider: "parley" }), "/rec/call.m4a");
    expect(fileCalls()).toEqual([
      expect.objectContaining({ provider: "parley", apiKey: "sess_1", batchUrl: expect.stringMatching(/\/stt\/batch$/) }),
    ]);
  });

  it("sends the on-device model id once it is downloaded", async () => {
    localModels = [{ id: "m1", installed: true, downloading: false }];
    await transcribeRecording(settingsFor({ transcriptionProvider: "local", localSttModel: "m1" }), "/rec/call.m4a");
    expect(fileCalls()).toEqual([
      expect.objectContaining({ provider: "local", apiKey: "local", model: "m1", diarization: false, batchUrl: null }),
    ]);
  });
});

describe("transcribeRecording failures", () => {
  const local = () => {
    localModels = [{ id: "m1", installed: true, downloading: false }];
    return settingsFor({ transcriptionProvider: "local", localSttModel: "m1" });
  };

  it("explains an on-device out-of-memory failure", async () => {
    transcribe = async () => {
      throw "whisper: not enough memory for model m1";
    };
    const e = await failure(local());
    expect((e as Error).message).toBe(translate("en", "localStt.error.memory"));
  });

  it("explains an on-device model that went missing", async () => {
    transcribe = async () => {
      throw new Error("model m1 is not downloaded");
    };
    const e = await failure(local());
    expect((e as Error).message).toBe(translate("en", "localStt.error.notReadyUpload"));
  });

  it("keeps any other on-device failure's own message", async () => {
    const original = new Error("decoder crashed");
    transcribe = async () => {
      throw original;
    };
    expect(await failure(local())).toBe(original);
    transcribe = async () => {
      throw "decoder crashed (string)";
    };
    const e = await failure(local());
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("decoder crashed (string)");
  });

  it("passes a BYOK failure through untouched, even a bare string", async () => {
    transcribe = async () => {
      throw "401 unauthorized";
    };
    expect(await failure(settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "k" }))).toBe("401 unauthorized");
  });
});
