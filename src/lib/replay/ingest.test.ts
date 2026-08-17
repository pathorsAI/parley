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
import { sttBatchUrl } from "../transcription/providers";

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

// The credential a provider is missing is NOT the same thing for everyone:
// hosted Parley has no key field, so telling the user to paste one sends them
// looking for a box that doesn't exist. These pin the branch.
describe("assertUploadTranscribable", () => {
  const base = useStore.getState().settings;
  const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });

  beforeEach(() => {
    useStore.setState({ cloudAuth: null });
  });

  it("refuses a provider without batch support without naming a replacement", () => {
    expect(() =>
      assertUploadTranscribable(settingsFor({ transcriptionProvider: "gemini" })),
    ).toThrow(/switch to another transcription provider in Settings/);
  });

  it("tells a BYOK provider's user to add an API key", () => {
    expect(() =>
      assertUploadTranscribable(
        settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "" }),
      ),
    ).toThrow(/Add your Soniox API key/);
  });

  it("tells a signed-out hosted user to sign in, not to paste a key", () => {
    let message = "";
    try {
      assertUploadTranscribable(settingsFor({ transcriptionProvider: "parley" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Sign in to Parley Cloud/);
    expect(message).not.toMatch(/API key/);
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
