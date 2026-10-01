import { beforeEach, describe, expect, it, vi } from "vitest";

// The ingest gate logs its refusals, and `log`'s Tauri-less path touches
// `window`. Logging is a side channel here, not the thing under test.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings } from "../types";
import { arbitrateImportPaths, assertUploadTranscribable } from "./ingest";
import { STT_BY_ID, sttBatchUrl } from "../transcription/providers";
import { translate } from "../../i18n/messages";

// The single audio-vs-transcript arbitration rule (R7) shared by the picker and
// the window drag-drop. If this rule changes, every import door changes with it.
describe("arbitrateImportPaths", () => {
  it("audio wins over transcripts when the set mixes kinds", () => {
    expect(
      arbitrateImportPaths(["/a/notes.txt", "/a/call.m4a", "/a/more.txt"]),
    ).toEqual({ kind: "audio", path: "/a/call.m4a" });
  });

  it("an only-.txt set imports ALL of them", () => {
    expect(arbitrateImportPaths(["/a/one.txt", "/a/two.TXT"])).toEqual({
      kind: "transcript",
      paths: ["/a/one.txt", "/a/two.TXT"],
    });
  });

  it("takes the first audio file only (one file per transcription run)", () => {
    expect(arbitrateImportPaths(["/a/first.mp3", "/a/second.wav"])).toEqual({
      kind: "audio",
      path: "/a/first.mp3",
    });
  });

  it("ignores paths that are neither audio nor transcript", () => {
    expect(arbitrateImportPaths(["/a/slides.pdf", "/a/pic.png"])).toBeNull();
    expect(arbitrateImportPaths([])).toBeNull();
  });

  it("matches audio extensions case-insensitively", () => {
    expect(arbitrateImportPaths(["/a/CALL.M4A"])).toEqual({
      kind: "audio",
      path: "/a/CALL.M4A",
    });
  });
});

// The refusals are user-facing, so they come from the i18n dictionaries in the
// user's language — and the missing-credential one names BOTH ways out (sign in
// to hosted Parley, or add a key), so a hosted user is never told to paste a
// key into a box that doesn't exist.
describe("assertUploadTranscribable", () => {
  const base = useStore.getState().settings;
  const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });
  const messageOf = (settings: Settings): string => {
    try {
      assertUploadTranscribable(settings);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  beforeEach(() => {
    useStore.setState({ cloudAuth: null });
  });

  it("refuses a provider without batch support, naming it, in the user's language", () => {
    const zh = messageOf(settingsFor({ transcriptionProvider: "gemini", language: "zh-TW" }));
    expect(zh).toBe(
      translate("zh-TW", "ingest.error.providerNoUpload", { provider: STT_BY_ID.gemini.label }),
    );
    expect(zh).toContain(STT_BY_ID.gemini.label);

    const en = messageOf(settingsFor({ transcriptionProvider: "gemini", language: "en" }));
    expect(en).toMatch(/can't transcribe uploaded files; pick another transcription provider/);
  });

  it("tells a BYOK user without a key how to get one, in the user's language", () => {
    const en = messageOf(
      settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "", language: "en" }),
    );
    expect(en).toBe(translate("en", "ingest.error.noSttKey"));
    expect(en).toMatch(/add a transcription key in Settings/);

    const zh = messageOf(
      settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "", language: "zh-TW" }),
    );
    expect(zh).toBe(translate("zh-TW", "ingest.error.noSttKey"));
  });

  it("offers a signed-out hosted user sign-in, not only a key", () => {
    const en = messageOf(settingsFor({ transcriptionProvider: "parley", language: "en" }));
    expect(en).toMatch(/Sign in to Parley/);
    expect(en).not.toMatch(/API key/);
  });

  it("passes hosted upload once a cloud session exists", () => {
    useStore.setState({
      cloudAuth: {
        token: "sess_123",
        user: { id: "u1", name: "Test", email: "t@example.com" },
        activeOrganizationId: null,
      },
    });
    expect(() =>
      assertUploadTranscribable(settingsFor({ transcriptionProvider: "parley" })),
    ).not.toThrow();
  });
});

// Provider-hiding: the hosted arm gets a cloud endpoint and BYOK providers get
// nothing (their adapter addresses the vendor itself).
describe("sttBatchUrl", () => {
  it("returns the cloud batch endpoint for hosted Parley only", () => {
    expect(sttBatchUrl("parley")).toMatch(/\/stt\/batch$/);
    expect(sttBatchUrl("soniox")).toBeUndefined();
    expect(sttBatchUrl("deepgram")).toBeUndefined();
  });
});
